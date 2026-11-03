import type { UserInputAnswer, UserInputQuestion, UserInputRequestedData } from "@harness/core";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useState } from "react";

interface DraftAnswer {
  custom: string;
  selected: string[];
}

export function UserInputCard({
  input,
  onResolve,
}: {
  input: UserInputRequestedData;
  onResolve: (answers: UserInputAnswer[]) => Promise<void>;
}) {
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(
      input.questions.map((question) => [question.id, { custom: "", selected: [] }]),
    ),
  );
  const question = input.questions[page];
  if (question === undefined) return null;
  const draft = drafts[question.id] ?? { custom: "", selected: [] };
  const answered = (item: UserInputQuestion) => {
    const answer = drafts[item.id];
    return answer !== undefined && (answer.selected.length > 0 || answer.custom.trim() !== "");
  };
  const allAnswered = input.questions.every(answered);
  const canContinue = answered(question);

  const updateDraft = (next: DraftAnswer) => {
    setDrafts((current) => ({ ...current, [question.id]: next }));
    setError(null);
  };

  const choose = (optionId: string) => {
    if (question.multiSelect) {
      updateDraft({
        ...draft,
        selected: draft.selected.includes(optionId)
          ? draft.selected.filter((id) => id !== optionId)
          : [...draft.selected, optionId],
      });
      return;
    }
    updateDraft({ ...draft, selected: [optionId] });
    if (page < input.questions.length - 1) {
      window.setTimeout(() => setPage((current) => current + 1), 120);
    }
  };

  const submit = async () => {
    if (!allAnswered || pending) return;
    setPending(true);
    setError(null);
    try {
      const answers: UserInputAnswer[] = input.questions.map((item) => {
        const answer = drafts[item.id] ?? { custom: "", selected: [] };
        const selectedOptions = item.multiSelect ? answer.selected : undefined;
        const selectedOption = item.multiSelect ? undefined : answer.selected[0];
        const labels = (selectedOptions ?? (selectedOption === undefined ? [] : [selectedOption]))
          .map((id) => item.options.find((option) => option.id === id)?.label ?? id)
          .join("、");
        return {
          questionId: item.id,
          ...(selectedOption === undefined ? {} : { selectedOption }),
          ...(selectedOptions === undefined ? {} : { selectedOptions }),
          value: answer.custom.trim() !== "" ? answer.custom.trim() : labels,
        };
      });
      await onResolve(answers);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "提交回答失败");
      setPending(false);
    }
  };

  return (
    <section className="user-input-card">
      <div className="user-input-head">
        <div>
          <span className="user-input-kicker">Agent 需要你的决定</span>
          <h3>{question.title}</h3>
        </div>
        {input.questions.length > 1 ? (
          <span className="user-input-progress">
            {page + 1} / {input.questions.length}
          </span>
        ) : null}
      </div>
      {question.body !== "" ? <p className="user-input-body">{question.body}</p> : null}
      {question.options.length > 0 ? (
        <fieldset aria-label={question.title} className="user-input-options">
          <legend className="sr-only">{question.title}</legend>
          {question.options.map((option) => {
            const selected = draft.selected.includes(option.id);
            return (
              <button
                aria-pressed={selected}
                className={`user-input-option${selected ? " active" : ""}`}
                key={option.id}
                onClick={() => choose(option.id)}
                type="button"
              >
                <span className={`user-input-check${question.multiSelect ? " multi" : ""}`}>
                  {selected ? <Check size={11} /> : null}
                </span>
                <span>
                  <strong>{option.label}</strong>
                  {option.description !== undefined ? <small>{option.description}</small> : null}
                </span>
              </button>
            );
          })}
        </fieldset>
      ) : null}
      {question.allowCustomInput ? (
        <label className="user-input-custom">
          <span>{question.options.length > 0 ? "或自己输入" : "你的回答"}</span>
          <input
            onChange={(event) => updateDraft({ ...draft, custom: event.target.value })}
            placeholder="输入你的选择…"
            value={draft.custom}
          />
        </label>
      ) : null}
      {error !== null ? <p className="settings-inline-error">{error}</p> : null}
      <div className="user-input-actions">
        {page > 0 ? (
          <button
            className="btn btn-ghost"
            onClick={() => setPage((value) => value - 1)}
            type="button"
          >
            <ArrowLeft size={13} /> 上一题
          </button>
        ) : (
          <span />
        )}
        {page < input.questions.length - 1 ? (
          <button
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => setPage((value) => value + 1)}
            type="button"
          >
            下一题 <ArrowRight size={13} />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!allAnswered || pending}
            onClick={() => void submit()}
            type="button"
          >
            {pending ? "提交中…" : "提交回答"}
          </button>
        )}
      </div>
    </section>
  );
}
