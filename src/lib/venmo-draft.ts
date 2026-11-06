/** Local draft limits; these are not Venmo account or payment limits. */
export const VENMO_DRAFT_HANDLE_MAX_LENGTH = 40;
export const VENMO_DRAFT_AMOUNT_MAX_LENGTH = 32;

type CheckedText = { ok: true; display: string } | { ok: false; message: string };

/** Check a manually entered username without claiming it exists on Venmo. */
export function checkDraftRecipient(value: string): CheckedText {
  if (!value) return { ok: false, message: "Enter a Venmo username." };
  const handle = value.startsWith("@") ? value.slice(1) : value;
  if (handle.length > VENMO_DRAFT_HANDLE_MAX_LENGTH) {
    return { ok: false, message: "Use a username of no more than 40 characters for this draft." };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(handle)) {
    return { ok: false, message: "Remove spaces or extra @ symbols and enter a simple username." };
  }
  return { ok: true, display: `@${handle}` };
}

/** Venmo's published profile guidance, checked 2026-11-06; older handles are not rewritten.
 * https://help.venmo.com/cs/articles/check-or-edit-your-username-vhel208
 */
export function followsPublishedUsernameGuidance(value: string): boolean {
  const checked = checkDraftRecipient(value);
  return checked.ok && /^[A-Za-z0-9_-]{5,30}$/.test(checked.display.slice(1));
}

/** Format dollars and cents from text, without floating-point rounding. */
export function checkDraftAmount(value: string): CheckedText {
  if (!value) return { ok: false, message: "Enter an amount in USD." };
  if (value.length > VENMO_DRAFT_AMOUNT_MAX_LENGTH) {
    return { ok: false, message: "Use no more than 32 characters for this draft." };
  }
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d*)$/.test(value)) {
    return { ok: false, message: "Use digits and one decimal point or comma, without a sign or thousands separator." };
  }
  if (value.endsWith(".") || value.endsWith(",")) {
    return { ok: false, message: "Finish entering the amount." };
  }
  const [integerPart = "", fractionalPart = ""] = value.split(/[.,]/);
  if (fractionalPart.length > 2) return { ok: false, message: "Use no more than two decimal places." };
  const whole = (integerPart || "0").replace(/^0+(?=\d)/, "");
  const cents = fractionalPart.padEnd(2, "0");
  if (whole === "0" && cents === "00") return { ok: false, message: "Enter an amount greater than $0.00." };
  return { ok: true, display: `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}` };
}
