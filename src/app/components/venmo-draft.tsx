"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent } from "react";
import { checkDraftAmount, checkDraftRecipient, followsPublishedUsernameGuidance, VENMO_DRAFT_AMOUNT_MAX_LENGTH, VENMO_DRAFT_HANDLE_MAX_LENGTH } from "@/lib/venmo-draft";
import type { LocalDataStorage } from "@/lib/customer-session-storage";
import { usePrivateDataScope } from "./customer-session";
import SavedVenmoContacts from "./saved-venmo-contacts";
import type { VenmoContact } from "@/lib/venmo-contacts-web";
import styles from "./venmo-draft.module.css";

// A previous screen's clipboard write must finish before a newer draft is copied.
const draftClipboardGuard = { pending: false };
const NOTE_MAX_LENGTH = 120;
type DraftCopyTarget = "details" | "recipient" | "amount" | "note";
type DraftField = "recipient" | "amount" | "note";

// Keep the full pasted value from being silently shortened by an HTML maxlength.
function guardPaste(
  event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  limit: number,
  reject: () => void,
) {
  const field = event.currentTarget;
  const selectionStart = field.selectionStart ?? field.value.length;
  const selectionEnd = field.selectionEnd ?? selectionStart;
  if (field.value.length - (selectionEnd - selectionStart) + event.clipboardData.getData("text").length > limit) {
    event.preventDefault();
    reject();
  }
}

export default function VenmoDraft() {
  const privateData = usePrivateDataScope();
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const focusFormRef = useRef(false);
  const copyGeneration = useRef(0);
  const inputValues = useRef<Record<DraftField, string>>({ recipient: "", amount: "", note: "" });
  const inputFailures = useRef<Record<DraftField, string>>({ recipient: "", amount: "", note: "" });
  const selectedContactRef = useRef<{ id: string; handle: string; storage: LocalDataStorage } | null>(null);
  const previousStorageRef = useRef(privateData.storage);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyTarget, setCopyTarget] = useState<DraftCopyTarget | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [recipientInputError, setRecipientInputError] = useState("");
  const [amountInputError, setAmountInputError] = useState("");
  const [noteInputError, setNoteInputError] = useState("");
  const [selectedContact, setSelectedContact] = useState<{ id: string; handle: string; storage: LocalDataStorage } | null>(null);
  const [savedContactWarning, setSavedContactWarning] = useState("");
  const [savedContactWarningAcknowledged, setSavedContactWarningAcknowledged] = useState(false);
  const recipientCheck = checkDraftRecipient(recipient);
  const amountCheck = checkDraftAmount(amount);
  const recipientError = recipientInputError || (submitted && !recipientCheck.ok ? recipientCheck.message : "");
  const amountError = amountInputError || (submitted && !amountCheck.ok ? amountCheck.message : "");

  function boundedChange(
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    field: DraftField,
    limit: number,
    setValue: (value: string) => void,
    setError: (message: string) => void,
    message: string,
  ) {
    const value = event.currentTarget.value;
    if (value.length > limit) {
      // Some input methods do not dispatch paste; reject their full value too.
      event.currentTarget.value = inputValues.current[field];
      setInputFailure(field, setError, message);
      return;
    }
    inputValues.current[field] = value;
    setInputFailure(field, setError, "");
    setValue(value);
  }

  function setInputFailure(field: DraftField, setError: (message: string) => void, message: string) {
    inputFailures.current[field] = message;
    setError(message);
  }

  const recipientLimitMessage = "That input is too long and was not added. Edit the username before continuing.";
  const amountLimitMessage = "That input is too long and was not added. Edit the amount before continuing.";
  const noteLimitMessage = "That input exceeds 120 characters and was not added. Edit the note before continuing.";

  useEffect(() => {
    if (reviewing) reviewHeadingRef.current?.focus();
    else if (focusFormRef.current) {
      recipientRef.current?.focus();
      focusFormRef.current = false;
    }
  }, [reviewing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (previousStorageRef.current !== privateData.storage) {
      previousStorageRef.current = privateData.storage;
      selectedContactRef.current = null;
      setSelectedContact(null);
      setSavedContactWarning("");
      setSavedContactWarningAcknowledged(false);
    }
  }, [privateData.storage]);

  const selectedContactForScope = selectedContact?.storage === privateData.storage ? selectedContact : null;

  const onSavedContactsChanged = useCallback((_previous: VenmoContact[], current: VenmoContact[]) => {
    const applied = selectedContactRef.current;
    if (!applied || applied.storage !== privateData.storage) return;
    const latest = current.find((contact) => contact.id === applied.id);
    if (!latest || latest.handle.toLowerCase() !== applied.handle.toLowerCase()) {
      setSavedContactWarning("The saved contact changed or was removed after you selected it. The draft still holds the previous recipient. Check it in Venmo, or select the updated contact before copying.");
      setSavedContactWarningAcknowledged(false);
      setCopyMessage("");
      setCopyFailed(false);
    }
  }, [privateData.storage]);

  function selectSavedContact(contact: VenmoContact) {
    const value = `@${contact.handle}`;
    inputValues.current.recipient = value;
    inputFailures.current.recipient = "";
    selectedContactRef.current = { id: contact.id, handle: contact.handle, storage: privateData.storage };
    setSelectedContact(selectedContactRef.current);
    setRecipient(value);
    setRecipientInputError("");
    setSubmitted(false);
    setSavedContactWarning("");
    setSavedContactWarningAcknowledged(false);
  }

  function updateRecipient(event: ChangeEvent<HTMLInputElement>) {
    boundedChange(event, "recipient", VENMO_DRAFT_HANDLE_MAX_LENGTH + 1, setRecipient, setRecipientInputError, recipientLimitMessage);
    const applied = selectedContactRef.current;
    if (!applied) return;
    const accepted = checkDraftRecipient(inputValues.current.recipient);
    if (applied.storage !== privateData.storage || !accepted.ok || accepted.display.slice(1).toLowerCase() !== applied.handle.toLowerCase()) {
      selectedContactRef.current = null;
      setSelectedContact(null);
      setSavedContactWarning("");
      setSavedContactWarningAcknowledged(false);
    }
  }

  function reviewDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!draftClipboardGuard.pending) {
      setCopyMessage("");
      setCopyFailed(false);
    }
    const currentRecipient = checkDraftRecipient(inputValues.current.recipient);
    const currentAmount = checkDraftAmount(inputValues.current.amount);
    if (!currentRecipient.ok || !currentAmount.ok || inputFailures.current.recipient || inputFailures.current.amount || inputFailures.current.note) {
      if (!currentRecipient.ok || inputFailures.current.recipient) recipientRef.current?.focus();
      else if (!currentAmount.ok || inputFailures.current.amount) amountRef.current?.focus();
      else noteRef.current?.focus();
      return;
    }
    setReviewing(true);
  }

  function clearDraft() {
    copyGeneration.current += 1;
    focusFormRef.current = true;
    inputValues.current = { recipient: "", amount: "", note: "" };
    inputFailures.current = { recipient: "", amount: "", note: "" };
    setRecipient("");
    setAmount("");
    setNote("");
    setRecipientInputError("");
    selectedContactRef.current = null;
    setSelectedContact(null);
    setSavedContactWarning("");
    setSavedContactWarningAcknowledged(false);
    setAmountInputError("");
    setNoteInputError("");
    setCopyMessage(draftClipboardGuard.pending ? "An earlier copy is still in progress and may reach the clipboard." : "Draft cleared.");
    setCopyFailed(draftClipboardGuard.pending);
    setSubmitted(false);
    setReviewing(false);
  }

  function editDraft() {
    copyGeneration.current += 1;
    focusFormRef.current = true;
    setCopyMessage(draftClipboardGuard.pending ? "An earlier copy is still in progress and may contain previous details." : "");
    setCopyFailed(draftClipboardGuard.pending);
    setReviewing(false);
  }

  async function copyDetails(target: DraftCopyTarget) {
    if (savedContactWarning && !savedContactWarningAcknowledged) {
      setCopyFailed(true);
      setCopyMessage("Check the changed recipient in Venmo, then confirm the check before copying this draft.");
      return;
    }
    const currentRecipient = checkDraftRecipient(inputValues.current.recipient);
    const currentAmount = checkDraftAmount(inputValues.current.amount);
    if (!currentRecipient.ok || !currentAmount.ok || inputFailures.current.recipient || inputFailures.current.amount || inputFailures.current.note) {
      setSubmitted(true);
      focusFormRef.current = true;
      setReviewing(false);
      return;
    }
    if (draftClipboardGuard.pending) {
      setCopyFailed(true);
      setCopyMessage("Another draft copy is in progress. Wait for it to finish, then copy this draft.");
      return;
    }
    const detailLines = [
      "Venmo payment draft",
      `Recipient: ${currentRecipient.display}`,
      `Amount: ${currentAmount.display}`,
      inputValues.current.note.trim() ? `Note: ${inputValues.current.note.trim()}` : "",
      "Draft only. Open Venmo yourself to review and send manually.",
    ].filter(Boolean);
    const trimmedNote = inputValues.current.note.trim();
    const copyText = target === "recipient" ? currentRecipient.display
      : target === "amount" ? currentAmount.display.slice(1).replaceAll(",", "")
      : target === "note" ? trimmedNote : detailLines.join("\n");
    if (!copyText) return;

    draftClipboardGuard.pending = true;
    const generation = ++copyGeneration.current;
    setCopyBusy(true);
    setCopyTarget(target);
    setCopyMessage("");
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(copyText);
      if (mountedRef.current && generation === copyGeneration.current) {
        setCopyFailed(false);
        const copiedLabel = target === "details" ? "Draft details" : target === "recipient" ? "Recipient" : target === "amount" ? "Amount in USD" : "Note";
        setCopyMessage(`${copiedLabel} copied. Clipboard text may remain after leaving Portfolio. Open Venmo separately to review and send manually.`);
      }
    } catch {
      if (mountedRef.current && generation === copyGeneration.current) {
        setCopyFailed(true);
        setCopyMessage("Copy is unavailable. Use the draft details above in Venmo manually.");
      }
    } finally {
      draftClipboardGuard.pending = false;
      if (mountedRef.current) {
        setCopyBusy(false);
        setCopyTarget(null);
        if (generation !== copyGeneration.current) {
          setCopyFailed(true);
          setCopyMessage("An earlier copy attempt finished. Review and copy any updated details again.");
        }
      }
    }
  }

  return (
    <section className={styles.card} aria-labelledby="venmo-draft-title">
      <header className={styles.header}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>VENMO PAYMENT DRAFT</p>
          <h3 id="venmo-draft-title">Prepare a payment in Venmo</h3>
          <p>Draft here; review and send in Venmo.</p>
        </div>
        <span className={styles.draftBadge}>Draft only · no payment sent</span>
      </header>
      <p className={styles.availabilityNote}>Venmo is available only in the U.S. and eligibility requirements apply. <a href="https://help.venmo.com/cs/articles/requirements-vhel170" target="_blank" rel="noreferrer">See Venmo requirements</a>.</p>

      {!reviewing ? (
        <form className={styles.form} onSubmit={reviewDraft} noValidate>
          {(recipientError || amountError || noteInputError) && <p className={styles.errorMessage} role="alert">Check the highlighted fields before reviewing this draft.</p>}
          {copyMessage && <p className={copyFailed ? styles.errorMessage : styles.successMessage} role="status" aria-live="polite">{copyMessage}</p>}
          <div className={styles.fields}>
            <label className={styles.field} htmlFor="venmo-draft-recipient">
              <span>Venmo username</span>
              <input
                id="venmo-draft-recipient"
                ref={recipientRef}
                name="recipient"
                type="text"
                value={recipient}
                onChange={updateRecipient}
                onPaste={(event) => guardPaste(event, VENMO_DRAFT_HANDLE_MAX_LENGTH + 1, () => setInputFailure("recipient", setRecipientInputError, recipientLimitMessage))}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="e.g. @username"
                aria-invalid={Boolean(recipientError)}
                aria-describedby={`venmo-recipient-help${recipientError ? " venmo-recipient-error" : ""}`}
                required
              />
              <small id="venmo-recipient-help">Venmo’s current guidance is 5–30 characters, using letters, numbers, hyphens or underscores. Verify the username in Venmo.</small>
              {recipientError && <small id="venmo-recipient-error" className={styles.fieldError}>{recipientError}</small>}
            </label>

            <label className={styles.field} htmlFor="venmo-draft-amount">
              <span>Amount in USD</span>
              <span className={`${styles.amountField}${amountError ? ` ${styles.amountFieldInvalid}` : ""}`}>
                <span aria-hidden="true">$</span>
                <input
                  id="venmo-draft-amount"
                  ref={amountRef}
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(event) => boundedChange(event, "amount", VENMO_DRAFT_AMOUNT_MAX_LENGTH, setAmount, setAmountInputError, amountLimitMessage)}
                  onPaste={(event) => guardPaste(event, VENMO_DRAFT_AMOUNT_MAX_LENGTH, () => setInputFailure("amount", setAmountInputError, amountLimitMessage))}
                  placeholder="0.00"
                  aria-invalid={Boolean(amountError)}
                  aria-describedby={`venmo-amount-help${amountError ? " venmo-amount-error" : ""}`}
                  required
                />
              </span>
              <small id="venmo-amount-help">Use a decimal point or comma, without thousands separators. Check the amount again in Venmo.</small>
              {amountError && <small id="venmo-amount-error" className={styles.fieldError}>{amountError}</small>}
            </label>

            <label className={`${styles.field} ${styles.noteField}`} htmlFor="venmo-draft-note">
              <span>Note <span className={styles.optional}>(optional)</span></span>
              <textarea
                id="venmo-draft-note"
                ref={noteRef}
                name="note"
                value={note}
                onChange={(event) => boundedChange(event, "note", NOTE_MAX_LENGTH, setNote, setNoteInputError, noteLimitMessage)}
                onPaste={(event) => guardPaste(event, NOTE_MAX_LENGTH, () => setInputFailure("note", setNoteInputError, noteLimitMessage))}
                aria-invalid={Boolean(noteInputError)}
                aria-describedby={`venmo-note-help${noteInputError ? " venmo-note-error" : ""}`}
                rows={3}
                placeholder="Add a short note for your draft"
              />
              <small id="venmo-note-help">{note.length}/120 characters</small>
              {noteInputError && <small id="venmo-note-error" className={styles.fieldError}>{noteInputError}</small>}
            </label>
          </div>

          <div className={styles.formActions}>
            <button className={styles.primaryButton} type="submit">Review payment draft</button>
          </div>
        </form>
      ) : (
        <div className={styles.review}>
          <h4 className={styles.reviewHeading} ref={reviewHeadingRef} tabIndex={-1}>Review payment draft</h4>
          {savedContactWarning && <div className={styles.recipientReviewNotice} role="alert">
            <strong>Recipient check needed</strong>
            <span>{savedContactWarning}</span>
            <button type="button" className={styles.secondaryButton} onClick={() => { setSavedContactWarningAcknowledged(true); setCopyMessage(""); setCopyFailed(false); }}>I checked this username in Venmo</button>
          </div>}
          {recipientCheck.ok && !followsPublishedUsernameGuidance(recipient) && (
            <p className={styles.recipientNotice} role="status">This username differs from Venmo’s current published format. Check it carefully in Venmo.</p>
          )}

          <dl className={styles.summary}>
            <div>
              <dt>Recipient</dt>
              <dd><span>{recipientCheck.ok ? recipientCheck.display : "—"}</span><button type="button" onClick={() => copyDetails("recipient")} disabled={copyBusy}>{copyBusy && copyTarget === "recipient" ? "Copying…" : "Copy recipient"}</button></dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd><span>{amountCheck.ok ? amountCheck.display : "—"}</span><button type="button" onClick={() => copyDetails("amount")} disabled={copyBusy}>{copyBusy && copyTarget === "amount" ? "Copying…" : "Copy amount"}</button></dd>
            </div>
            {note.trim() && (
              <div className={styles.noteSummary}>
                <dt>Note</dt>
                <dd><span>{note.trim()}</span><button type="button" onClick={() => copyDetails("note")} disabled={copyBusy}>{copyBusy && copyTarget === "note" ? "Copying…" : "Copy note"}</button></dd>
              </div>
            )}
          </dl>

          <p className={styles.nextStep}>
            Check the recipient in Venmo before sending. Amounts copy as USD digits and cents.
          </p>

          <div className={styles.actions} aria-busy={copyBusy}>
            <button className={styles.primaryButton} type="button" onClick={() => copyDetails("details")} disabled={copyBusy}>{copyBusy && copyTarget === "details" ? "Copying…" : "Copy draft details"}</button>
            <button className={styles.secondaryButton} type="button" onClick={editDraft}>Edit draft</button>
            <button className={styles.clearButton} type="button" onClick={clearDraft}>Clear draft</button>
          </div>

          {copyMessage && (
            <p className={copyFailed ? styles.errorMessage : styles.successMessage} role="status" aria-live="polite">
              {copyMessage}
            </p>
          )}
        </div>
      )}

      {savedContactWarning && !reviewing && <p className={styles.recipientNotice} role="alert">{savedContactWarning}</p>}
      <SavedVenmoContacts disabled={reviewing} selectedContact={selectedContactForScope} onSelect={selectSavedContact} onContactsChanged={onSavedContactsChanged} />
      <p className={styles.privacyNote}>Draft clears when you leave Portfolio. Clipboard may retain copied text. Usernames stay on this device, scoped to the guest or verified session; browser storage is unencrypted and unsynced. Device contacts are not imported.</p>
    </section>
  );
}
