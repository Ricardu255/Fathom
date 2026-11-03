export const COMPACTION_MARKER = "[[COMPACT_SUMMARY]]";

export const COMPACTION_SYSTEM_PROMPT = `${COMPACTION_MARKER}
你负责压缩 Agent 对话的历史，供后续请求继续使用。只输出摘要正文，不要 JSON，不要解释过程。

摘要必须保留：
1. 用户的目标、约束与明确偏好；
2. 已确认的事实、决定和未完成事项；
3. 已执行的关键工具操作及其结论（不要保留大段原文）；
4. 仍然相关的文件路径、错误和待验证假设。

不要编造未出现的信息，不要包含寒暄。用紧凑的要点式中文，控制在 400 字以内。`;
