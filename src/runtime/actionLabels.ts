const GENERIC_SETUP_ACTION_PATTERNS = [
  /^e[\s-]?commerce$/,
  /^health\s*care$/,
  /^home\s+services?$/,
  /^book\s+(a\s+)?demo$/,
];

export function cleanActionLabel(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`.!?]+$/g, '')
    .trim()
    .slice(0, 24)
    .trim();
}

export function isGenericSetupAction(value: unknown): boolean {
  const label = cleanActionLabel(value).toLowerCase();
  return GENERIC_SETUP_ACTION_PATTERNS.some((pattern) => pattern.test(label));
}

export function uniqueActionLabels(value: unknown, opts: { allowSetupCategories?: boolean } = {}): string[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  return raw
    .map(cleanActionLabel)
    .filter((action) => {
      const key = action.toLowerCase();
      if (!action || seen.has(key)) return false;
      if (!opts.allowSetupCategories && isGenericSetupAction(action)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}
