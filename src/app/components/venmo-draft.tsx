"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { checkDraftAmount, checkDraftRecipient, followsPublishedUsernameGuidance, VENMO_DRAFT_AMOUNT_MAX_LENGTH, VENMO_DRAFT_HANDLE_MAX_LENGTH } from "@/lib/venmo-draft";
import styles from "./venmo-draft.module.css";

// A previous screen's clipboard write must finish before a newer draft is copied.
const draftClipboardGuard = { pending: false };

export default function VenmoDraft() {
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const recipientRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const focusFormRef = useRef(false);
  const copyGeneration = useRef(0);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const recipientCheck = checkDraftRecipient(recipient);
  const amountCheck = checkDraftAmount(amount);
  const recipientError = submitted && !recipientCheck.ok ? recipientCheck.message : "";
  const amountError = submitted && !amountCheck.ok ? amountCheck.message : "";

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

  function reviewDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!draftClipboardGuard.pending) {
      setCopyMessage("");
      setCopyFailed(false);
    }
    if (!recipientCheck.ok || !amountCheck.ok) {
      if (!recipientCheck.ok) recipientRef.current?.focus();
      else amountRef.current?.focus();
      return;
    }
    setReviewing(true);
  }

  function clearDraft() {
    copyGeneration.current += 1;
    focusFormRef.current = true;
    setRecipient("");
    setAmount("");
    setNote("");
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

  async function copyDetails() {
    const currentRecipient = checkDraftRecipient(recipient);
    const currentAmount = checkDraftAmount(amount);
    if (!currentRecipient.ok || !currentAmount.ok) {
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
      note.trim() ? `Note: ${note.trim()}` : "",
      "Draft only. Open Venmo yourself to review and send manually.",
    ].filter(Boolean);

    draftClipboardGuard.pending = true;
    const generation = ++copyGeneration.current;
    setCopyBusy(true);
    setCopyMessage("");
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(detailLines.join("\n"));
      if (mountedRef.current && generation === copyGeneration.current) {
        setCopyFailed(false);
        setCopyMessage("Copied. Clipboard text may remain after leaving Portfolio. Open Venmo separately to review and send manually.");
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
          <p>Enter a recipient and amount here, then review and send in Venmo yourself.</p>
        </div>
        <span className={styles.draftBadge}>Draft only · no payment sent</span>
      </header>

      {!reviewing ? (
        <form className={styles.form} onSubmit={reviewDraft} noValidate>
          {(recipientError || amountError) && <p className={styles.errorMessage} role="alert">Check the highlighted fields before reviewing this draft.</p>}
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
                onChange={(event) => setRecipient(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={VENMO_DRAFT_HANDLE_MAX_LENGTH + 1}
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
                  maxLength={VENMO_DRAFT_AMOUNT_MAX_LENGTH}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
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
                name="note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={120}
                rows={3}
                placeholder="Add a short note for your draft"
              />
              <small>{note.length}/120 characters</small>
            </label>
          </div>

          <div className={styles.formActions}>
            <button className={styles.primaryButton} type="submit">Review payment draft</button>
          </div>
        </form>
      ) : (
        <div className={styles.review}>
          <h4 className={styles.reviewHeading} ref={reviewHeadingRef} tabIndex={-1}>Review payment draft</h4>
          <div className={styles.reviewNotice}>
            <strong>Draft only · no payment sent</strong>
            <span>Open Venmo yourself and check the recipient before deciding whether to send.</span>
          </div>
          {recipientCheck.ok && !followsPublishedUsernameGuidance(recipient) && (
            <p className={styles.recipientNotice} role="status">This username differs from Venmo’s current published format. Check it carefully in Venmo.</p>
          )}

          <dl className={styles.summary}>
            <div>
              <dt>Recipient</dt>
              <dd>{recipientCheck.ok ? recipientCheck.display : "—"}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{amountCheck.ok ? amountCheck.display : "—"}</dd>
            </div>
            {note.trim() && (
              <div className={styles.noteSummary}>
                <dt>Note</dt>
                <dd>{note.trim()}</dd>
              </div>
            )}
          </dl>

          <p className={styles.nextStep}>
            Copying places these details on your device clipboard at your request; copied text may remain there after you leave Portfolio. This app does not save the draft, open Venmo, or send a payment.
          </p>

          <div className={styles.actions} aria-busy={copyBusy}>
            <button className={styles.primaryButton} type="button" onClick={copyDetails} disabled={copyBusy}>{copyBusy ? "Copying…" : "Copy draft details"}</button>
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

      <p className={styles.privacyNote}>The draft clears when you leave Portfolio; copied text may remain on your clipboard. No device contacts are imported.</p>
    </section>
  );
}
