const COMMIT =
  /我决定|我们决定|我确定|改回|改用|就用|定下来|(?:\bI|\bwe) (?:have )?(?:decided|choose|chose)|\b(?:we|I)(?:'ll| will) (?:use|switch to|go with)\b/i;
const UNCERTAIN =
  /[?？]|决定不(?:用|选)|不再用|decided not to|(?:要不要|考虑|假设|如果|假如|也许|可能|扮演|剧本|台词|他说|她说|转述)|\b(?:maybe|considering|suppose|what if|if we|if I|roleplay|he said|she said)\b/i;

export function isExplicitDecisionText(text: string): boolean {
  const direct = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|`[^`]*`/g, "");
  return !UNCERTAIN.test(text) && COMMIT.test(direct);
}
