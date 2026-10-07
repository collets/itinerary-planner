/** Read-only questions must not enter scheduling or routing, including replies. */
export function informationQuestion(text: string) {
  return (
    /informazion|\binfo\b|orar[io]|apertur|prezz|\bcost[oi]\b|curios|trivia|opening|hours|prices|entrance fee/i.test(
      text,
    ) &&
    !/aggiung|sostitui|spost|ritard|anticip|posticip|accorci|cambia|modifica|salta|add.*(?:stop|visit)|replace|reschedul|skip/i.test(
      text,
    )
  );
}

export function confirmationReply(text: string) {
  const normalized = text
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('it')
    .replace(/[,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:s[iì]|yes|ok|okay|va bene|certo|procedi|confermo)(?: grazie| thanks| please)?$/.test(
    normalized,
  );
}
