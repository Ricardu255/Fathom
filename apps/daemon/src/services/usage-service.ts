import { type HarnessEvent, HarnessEventType } from "@harness/core";
import type { HarnessDatabase, SessionRecord } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";

export interface ModelPricing {
  input: number;
  output: number;
}

export type PricingLookup = (providerId: string, modelId: string) => ModelPricing | null;

export interface UsageRecord {
  costUsd: number | null;
  day: string;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  providerId: string;
  requests: number;
  source: "main" | "subagent";
  timestamp: number;
}

export interface UsageDay {
  costComplete: boolean;
  costUsd: number;
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface UsageBreakdown {
  costUsd: number | null;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  providerId: string;
  requests: number;
}

export interface UsageSummary {
  byModel: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  compactionCount: number;
  costComplete: boolean;
  costUsd: number;
  days: UsageDay[];
  from: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  subAgentRuns: number;
  to: string;
  totalTokens: number;
}

interface SessionUsage {
  compactionCount: number;
  lastSeq: number;
  records: UsageRecord[];
  subAgentRuns: number;
}

export interface UsageServiceOptions {
  database: HarnessDatabase;
  events: SessionEventStore;
  pricing: PricingLookup;
}

/** 从 JSONL 事实源聚合用量；按 Session lastSeq 缓存，归档 Session 也计入。 */
export class UsageService {
  private readonly cache = new Map<string, SessionUsage>();

  public constructor(private readonly options: UsageServiceOptions) {}

  public async summarize(
    input: {
      from?: string | undefined;
      modelId?: string | undefined;
      providerId?: string | undefined;
      to?: string | undefined;
    } = {},
  ): Promise<UsageSummary> {
    const to = input.to ?? new Date().toISOString().slice(0, 10);
    const from = input.from ?? dateOffset(to, -364);
    const sessions = this.options.database.listSessions(true);
    const records: UsageRecord[] = [];
    let compactionCount = 0;
    let subAgentRuns = 0;
    for (const session of sessions) {
      const usage = await this.sessionUsage(session);
      compactionCount += usage.compactionCount;
      subAgentRuns += usage.subAgentRuns;
      for (const record of usage.records) {
        if (record.day < from || record.day > to) continue;
        if (input.providerId !== undefined && record.providerId !== input.providerId) continue;
        if (input.modelId !== undefined && record.modelId !== input.modelId) continue;
        records.push(record);
      }
    }
    return summarizeRecords(records, from, to, compactionCount, subAgentRuns);
  }

  private async sessionUsage(session: SessionRecord): Promise<SessionUsage> {
    const cached = this.cache.get(session.id);
    if (cached !== undefined && cached.lastSeq >= session.lastSeq) return cached;
    const events = await this.options.events.read(session.id, 0);
    const collected = collectUsage(events, session, this.options.pricing);
    const next: SessionUsage = {
      compactionCount: collected.compactionCount,
      lastSeq: Math.max(session.lastSeq, events.at(-1)?.seq ?? 0),
      records: collected.records,
      subAgentRuns: collected.subAgentRuns,
    };
    this.cache.set(session.id, next);
    return next;
  }
}

export function collectUsage(
  events: readonly HarnessEvent[],
  session: SessionRecord,
  pricing: PricingLookup,
): { compactionCount: number; records: UsageRecord[]; subAgentRuns: number } {
  const records: UsageRecord[] = [];
  const subAgentModels = new Map<string, string>();
  const subAgents = new Set<string>();
  let compactionCount = 0;
  const providerId = session.providerId ?? "unknown";
  const defaultModel = session.modelId ?? "unknown";

  const push = (
    data: { inputTokens?: unknown; modelId?: string | undefined; outputTokens?: unknown },
    source: "main" | "subagent",
    timestamp: number,
  ): void => {
    const inputTokens = numberOrZero(data.inputTokens);
    const outputTokens = numberOrZero(data.outputTokens);
    if (inputTokens === 0 && outputTokens === 0) return;
    const modelId = data.modelId ?? defaultModel;
    const cost = pricing(providerId, modelId);
    records.push({
      costUsd:
        cost === null
          ? null
          : (inputTokens / 1_000_000) * cost.input + (outputTokens / 1_000_000) * cost.output,
      day: new Date(timestamp).toISOString().slice(0, 10),
      inputTokens,
      modelId,
      outputTokens,
      providerId,
      requests: 1,
      source,
      timestamp,
    });
  };

  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === HarnessEventType.USAGE) {
      push(
        {
          inputTokens: data.inputTokens,
          modelId: typeof data.model === "string" ? data.model : undefined,
          outputTokens: data.outputTokens,
        },
        "main",
        event.timestamp,
      );
    } else if (event.type === HarnessEventType.SUBAGENT_STARTED) {
      if (typeof data.executionId === "string") {
        subAgents.add(data.executionId);
        if (typeof data.modelId === "string") subAgentModels.set(data.executionId, data.modelId);
      }
    } else if (
      event.type === HarnessEventType.SUBAGENT_COMPLETED ||
      event.type === HarnessEventType.SUBAGENT_FAILED ||
      event.type === HarnessEventType.SUBAGENT_ABORTED
    ) {
      const executionId = typeof data.executionId === "string" ? data.executionId : undefined;
      if (executionId !== undefined) subAgents.add(executionId);
      const usage = asRecord(data.usage);
      push(
        {
          inputTokens: usage.inputTokens,
          modelId: executionId === undefined ? undefined : subAgentModels.get(executionId),
          outputTokens: usage.outputTokens,
        },
        "subagent",
        event.timestamp,
      );
    } else if (event.type === HarnessEventType.CONTEXT_COMPACTED) {
      compactionCount += 1;
    }
  }

  return { compactionCount, records, subAgentRuns: subAgents.size };
}

function summarizeRecords(
  records: readonly UsageRecord[],
  from: string,
  to: string,
  compactionCount: number,
  subAgentRuns: number,
): UsageSummary {
  const dayMap = new Map<string, UsageDay>();
  const modelMap = new Map<string, UsageBreakdown>();
  const providerMap = new Map<string, UsageBreakdown>();
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  let costUsd = 0;
  let costComplete = true;

  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    requests += record.requests;
    if (record.costUsd === null) costComplete = false;
    else costUsd += record.costUsd;

    const day = dayMap.get(record.day) ?? {
      costComplete: true,
      costUsd: 0,
      date: record.day,
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    };
    day.inputTokens += record.inputTokens;
    day.outputTokens += record.outputTokens;
    day.requests += record.requests;
    if (record.costUsd === null) day.costComplete = false;
    else day.costUsd += record.costUsd;
    dayMap.set(record.day, day);

    const modelKey = `${record.providerId}:${record.modelId}`;
    const model = modelMap.get(modelKey) ?? {
      costUsd: 0,
      inputTokens: 0,
      modelId: record.modelId,
      outputTokens: 0,
      providerId: record.providerId,
      requests: 0,
    };
    addBreakdown(model, record);
    modelMap.set(modelKey, model);

    const provider = providerMap.get(record.providerId) ?? {
      costUsd: 0,
      inputTokens: 0,
      modelId: "*",
      outputTokens: 0,
      providerId: record.providerId,
      requests: 0,
    };
    addBreakdown(provider, record);
    providerMap.set(record.providerId, provider);
  }

  const days = enumerateDays(from, to).map(
    (date) =>
      dayMap.get(date) ?? {
        costComplete: true,
        costUsd: 0,
        date,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      },
  );
  return {
    byModel: [...modelMap.values()].sort((left, right) => right.inputTokens - left.inputTokens),
    byProvider: [...providerMap.values()].sort(
      (left, right) => right.inputTokens - left.inputTokens,
    ),
    compactionCount,
    costComplete,
    costUsd,
    days,
    from,
    inputTokens,
    outputTokens,
    requests,
    subAgentRuns,
    to,
    totalTokens: inputTokens + outputTokens,
  };
}

function addBreakdown(target: UsageBreakdown, record: UsageRecord): void {
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.requests += record.requests;
  if (record.costUsd === null) target.costUsd = null;
  else if (target.costUsd !== null) target.costUsd += record.costUsd;
}

function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return days;
  for (let time = start.getTime(); time <= end.getTime(); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
    if (days.length > 400) break;
  }
  return days;
}

function dateOffset(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
