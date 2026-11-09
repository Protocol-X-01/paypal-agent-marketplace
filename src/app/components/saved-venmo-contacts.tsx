"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent } from "react";
import type { LocalDataStorage } from "@/lib/customer-session-storage";
import {
  createWebVenmoContactsRepository,
  MAX_CONTACT_DISPLAY_NAME_LENGTH,
  MAX_CONTACT_HANDLE_LENGTH,
  MAX_VENMO_CONTACTS,
  VENMO_CONTACTS_STORAGE_KEY,
  type VenmoContact,
  type VenmoContactsMutationResult,
} from "@/lib/venmo-contacts-web";
import { collectionLocksAvailable } from "@/lib/collection-lock";
import { useCustomerSession, usePrivateDataScope } from "./customer-session";
import styles from "./venmo-draft.module.css";

type Props = {
  disabled: boolean;
  selectedContact: { id: string; handle: string } | null;
  onSelect: (contact: VenmoContact) => void;
  onContactsChanged: (previous: VenmoContact[], current: VenmoContact[]) => void;
};

type ContactsStatus = "loading" | "ready" | "corrupt" | "unavailable";

function boundedChange(
  event: ChangeEvent<HTMLInputElement>,
  limit: number,
  setValue: (value: string) => void,
  setMessage: (message: string) => void,
  field: "name" | "handle",
) {
  const value = event.currentTarget.value;
  if (value.length > limit) {
    setMessage(field === "name"
      ? `Use a display name of up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters.`
      : `Use a username of up to ${MAX_CONTACT_HANDLE_LENGTH} characters.`);
    return;
  }
  setValue(value);
  setMessage("");
}

function guardPaste(event: ClipboardEvent<HTMLInputElement>, limit: number, setMessage: (message: string) => void, field: "name" | "handle") {
  const input = event.currentTarget;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  if (input.value.length - (end - start) + event.clipboardData.getData("text").length > limit) {
    event.preventDefault();
    setMessage(field === "name"
      ? `That paste is too long. Use up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters for a display name.`
      : `That paste is too long. Use up to ${MAX_CONTACT_HANDLE_LENGTH} characters for a username.`);
  }
}

export default function SavedVenmoContacts(props: Props) {
  const { state } = useCustomerSession();
  return <SavedVenmoContactsForScope key={state.epoch} {...props} />;
}

function SavedVenmoContactsForScope({ disabled, selectedContact, onSelect, onContactsChanged }: Props) {
  const privateData = usePrivateDataScope();
  const storage = privateData.storage;
  const events = privateData.events;
  const mounted = useRef(false);
  const activeStorage = useRef<LocalDataStorage | null>(null);
  const contactsRef = useRef<VenmoContact[]>([]);
  const busyRef = useRef(false);
  const [contacts, setContacts] = useState<VenmoContact[]>([]);
  const [status, setStatus] = useState<ContactsStatus>("loading");
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmForgetCorrupt, setConfirmForgetCorrupt] = useState(false);
  const [lockUnavailable, setLockUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  const scopeIsCurrent = useCallback((expectedStorage: LocalDataStorage) => {
    if (!privateData.ready || !mounted.current || activeStorage.current !== expectedStorage) return false;
    try { return events.dispatchEvent(new Event("paypal-markets-scope-liveness")); } catch { return false; }
  }, [events, privateData.ready]);

  const repository = useMemo(
    () => createWebVenmoContactsRepository(storage),
    [storage],
  );

  const publishContacts = useCallback((next: VenmoContact[]) => {
    const previous = contactsRef.current;
    contactsRef.current = next;
    setContacts(next);
    onContactsChanged(previous, next);
  }, [onContactsChanged]);

  const loadContacts = useCallback((externalChange = false) => {
    const result = repository.loadVenmoContacts();
    if (!scopeIsCurrent(storage)) return;
    if (result.status === "ready") {
      const changed = JSON.stringify(contactsRef.current) !== JSON.stringify(result.contacts);
      publishContacts(result.contacts);
      setStatus("ready");
      if (externalChange && changed) {
        const editWasOpen = editingId !== null;
        setEditingId(null);
        setName("");
        setHandle("");
        setConfirmRemoveId(null);
        setConfirmForgetCorrupt(false);
        setMessage(editWasOpen
          ? "Saved contacts changed in another tab. Your open edit was closed without saving; review the latest list before continuing."
          : "Saved contacts changed in another tab. The latest list is loaded; review the recipient before copying.");
        setMessageError(false);
      }
    } else {
      publishContacts([]);
      setEditingId(null);
      setName("");
      setHandle("");
      setConfirmRemoveId(null);
      setConfirmForgetCorrupt(false);
      setStatus(result.status);
      setMessage(result.status === "corrupt"
        ? "Saved contact data could not be read and was left untouched. You can forget only this unreadable contact list from this local view."
        : "Saved contacts are unavailable until this browser session and its local storage can be verified.");
      setMessageError(result.status === "unavailable");
    }
  }, [editingId, publishContacts, repository, scopeIsCurrent, storage]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeStorage.current = null;
    };
  }, []);

  useEffect(() => {
    let live = true;
    activeStorage.current = null;
    if (!privateData.ready) {
      return () => { live = false; };
    }

    activeStorage.current = storage;
    queueMicrotask(() => { if (live) loadContacts(); });

    function handleStorage(event: StorageEvent) {
      if (!live || (event.key !== null && event.key !== VENMO_CONTACTS_STORAGE_KEY)) return;
      loadContacts(true);
    }
    function handleDataReset() {
      if (live) loadContacts(true);
    }
    events.addEventListener("storage", handleStorage);
    events.addEventListener("paypal-markets-data-reset", handleDataReset);
    return () => {
      live = false;
      events.removeEventListener("storage", handleStorage);
      events.removeEventListener("paypal-markets-data-reset", handleDataReset);
      if (activeStorage.current === storage) activeStorage.current = null;
    };
  }, [events, loadContacts, privateData.ready, storage]);

  function startEdit(contact: VenmoContact) {
    setConfirmRemoveId(null);
    setEditingId(contact.id);
    setName(contact.displayName);
    setHandle(`@${contact.handle}`);
    setMessage("");
    setMessageError(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setConfirmRemoveId(null);
    setName("");
    setHandle("");
    setMessage("");
    setMessageError(false);
  }

  function showResult(result: VenmoContactsMutationResult, success: string) {
    if (!scopeIsCurrent(storage)) return;
    setConfirmRemoveId(null);
    setConfirmForgetCorrupt(false);
    if (result.status === "ready") {
      publishContacts(result.contacts);
      setStatus("ready");
      setMessage(success);
      setMessageError(false);
      setEditingId(null);
      setName("");
      setHandle("");
      return;
    }
    if (result.status === "conflict") {
      if ("contacts" in result) publishContacts(result.contacts);
      const editWasOpen = editingId !== null;
      setEditingId(null);
      setName("");
      setHandle("");
      setStatus("ready");
      setMessage(editWasOpen
        ? "This list changed in another tab. Your open edit was closed without saving; review the latest contact before editing again."
        : "This list changed in another tab. The latest contacts are loaded; review and try again.");
      setMessageError(false);
      return;
    }
    if (result.status === "duplicate" || result.status === "limit" || result.status === "busy") {
      if ("contacts" in result) publishContacts(result.contacts);
      setStatus("ready");
      const messages = {
        duplicate: "That Venmo username is already saved. Check the latest list and try again.",
        limit: `You can save up to ${MAX_VENMO_CONTACTS} contacts. Remove one before adding another.`,
        busy: "Another local data change is in progress. Wait a moment, then try again.",
      };
      setMessage(messages[result.status]);
      setMessageError(result.status === "busy");
      return;
    }
    if (result.status === "unsupported") {
      setLockUnavailable(true);
      setMessage("This browser cannot safely coordinate local changes between tabs. Saved contacts are read-only here.");
      setMessageError(true);
      return;
    }
    if (result.status === "invalid-name") {
      setMessage(`Enter a display name of up to ${MAX_CONTACT_DISPLAY_NAME_LENGTH} characters.`);
      setMessageError(true);
      return;
    }
    if (result.status === "invalid-handle") {
      setMessage(`Enter a username of up to ${MAX_CONTACT_HANDLE_LENGTH} characters using letters, numbers, dots, underscores or hyphens.`);
      setMessageError(true);
      return;
    }
    setStatus(result.status);
    setMessage(result.status === "corrupt"
      ? "Saved contact data could not be read and was left untouched. Use Settings → Clear local data if you want to remove this unreadable copy."
      : "The local change could not be verified. Reload Portfolio before trying again.");
    setMessageError(true);
  }

  async function forgetUnreadableContacts() {
    if (!canForgetCorrupt || busyRef.current || !scopeIsCurrent(storage)) return;
    busyRef.current = true;
    setBusy(true);
    setConfirmForgetCorrupt(false);
    setMessage("");
    try {
      const result = await repository.forgetUnreadableVenmoContacts();
      if (!scopeIsCurrent(storage)) return;
      if (result.status === "forgotten") {
        publishContacts([]);
        setStatus("ready");
        setMessage("Unreadable saved contacts were removed from this device. Venmo is unchanged.");
        setMessageError(false);
      } else if (result.status === "changed") {
        publishContacts(result.contacts);
        setStatus("ready");
        setMessage("The saved contact data changed before it could be removed. Nothing was deleted; the latest readable list is loaded.");
        setMessageError(false);
      } else {
        if (result.status === "unsupported") setLockUnavailable(true);
        setMessage(result.status === "busy"
          ? "Another local data change is in progress. Nothing was removed; try again."
          : result.status === "unsupported"
            ? "This browser cannot safely coordinate local changes. The unreadable contact data remains untouched."
            : "The removal could not be verified. Reload Portfolio to check the saved contacts.");
        setMessageError(true);
      }
    } catch {
      if (scopeIsCurrent(storage)) {
        setMessage("The removal could not be verified. Reload Portfolio to check the saved contacts.");
        setMessageError(true);
      }
    } finally {
      busyRef.current = false;
      if (scopeIsCurrent(storage)) setBusy(false);
    }
  }

  async function saveContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canMutate || busyRef.current || !scopeIsCurrent(storage)) return;
    const expected = contactsRef.current.map((contact) => ({ ...contact }));
    const original = editingId ? expected.find((contact) => contact.id === editingId) : undefined;
    if (editingId && !original) {
      setMessage("This contact changed in another tab. Review the latest list before editing again.");
      setMessageError(true);
      loadContacts(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = original
        ? await repository.updateVenmoContact(expected, original, name, handle)
        : await repository.addVenmoContact(expected, name, handle);
      showResult(result, original ? "Contact updated on this device." : "Contact saved on this device.");
    } catch {
      if (scopeIsCurrent(storage)) {
        setStatus("unavailable");
        setMessage("The local change could not be verified. Reload Portfolio before trying again.");
        setMessageError(true);
      }
    } finally {
      busyRef.current = false;
      if (scopeIsCurrent(storage)) setBusy(false);
    }
  }

  async function removeContact(contact: VenmoContact) {
    if (!canMutate || busyRef.current || !scopeIsCurrent(storage)) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await repository.removeVenmoContact(contactsRef.current.map((item) => ({ ...item })), contact);
      showResult(result, "Contact removed from this device.");
    } catch {
      if (scopeIsCurrent(storage)) {
        setStatus("unavailable");
        setMessage("The local change could not be verified. Reload Portfolio before trying again.");
        setMessageError(true);
      }
    } finally {
      busyRef.current = false;
      if (scopeIsCurrent(storage)) setBusy(false);
    }
  }

  const isCurrent = privateData.ready && status !== "loading";
  const locksAvailable = collectionLocksAvailable();
  const canMutate = isCurrent && status === "ready" && locksAvailable && !lockUnavailable && !disabled && !busy;
  const canForgetCorrupt = isCurrent && status === "corrupt" && locksAvailable && !lockUnavailable && !disabled && !busy;
  const readOnlyForCoordination = !locksAvailable || lockUnavailable;
  const editing = editingId !== null;

  return (
    <section className={styles.contactsPanel} aria-labelledby="venmo-contacts-title">
      <div className={styles.contactsHeader}>
        <div>
          <h4 id="venmo-contacts-title">Saved Venmo contacts</h4>
          <p>{isCurrent && status === "ready" ? `${contacts.length} of ${MAX_VENMO_CONTACTS} saved on this device` : status === "corrupt" ? "Saved contact data needs attention" : status === "unavailable" ? "Saved contacts are temporarily unavailable" : "Available after this session is verified"}</p>
        </div>
        <span className={styles.contactsBadge}>Local only</span>
      </div>

      {!isCurrent ? (
        <p className={styles.contactsHint} role="status">Checking this session before loading saved contacts…</p>
      ) : status === "corrupt" ? (
        <div className={styles.contactRecovery}>
          <p className={styles.contactsHint} role="status">{message || "Saved contacts could not be read and were left untouched."}</p>
          <div className={styles.removeConfirmationActions}>
            <button type="button" className={`${styles.inlineButton} ${styles.removeContactButton}`} onClick={() => setConfirmForgetCorrupt((current) => !current)} disabled={!canForgetCorrupt} aria-expanded={confirmForgetCorrupt} aria-controls={confirmForgetCorrupt ? "venmo-contact-corrupt-confirm" : undefined}>
              {confirmForgetCorrupt ? "Cancel removal review" : "Forget unreadable contacts"}
            </button>
            {readOnlyForCoordination && <small className={styles.contactsHint}>This browser cannot safely coordinate local changes; saved contact data is read-only here.</small>}
          </div>
          {confirmForgetCorrupt && <div id="venmo-contact-corrupt-confirm" className={styles.removeConfirmation} role="group" aria-label="Confirm removal of unreadable saved contacts">
            <p>Forget only this unreadable saved contact list from this local view? It does not affect Venmo or other saved data.</p>
            <div className={styles.removeConfirmationActions}>
              <button type="button" className={styles.inlineButton} onClick={() => setConfirmForgetCorrupt(false)} disabled={busy}>Keep saved data</button>
              <button type="button" className={`${styles.inlineButton} ${styles.removeContactButton}`} onClick={() => { void forgetUnreadableContacts(); }} disabled={!canForgetCorrupt}>Forget unreadable contacts</button>
            </div>
          </div>}
        </div>
      ) : status === "unavailable" ? (
        <p className={styles.contactsHint} role="status">{message || "Saved contacts are unavailable."}</p>
      ) : (
        <>
          {readOnlyForCoordination && <p className={styles.contactsHint} role="status">This browser cannot safely coordinate local changes between tabs. Saved contacts are read-only here.</p>}
          {contacts.length > 0 ? (
            <ul className={styles.contactsList}>
              {contacts.map((contact) => {
                const selected = selectedContact?.id === contact.id && selectedContact.handle.toLowerCase() === contact.handle.toLowerCase();
                return <li className={styles.contactRow} key={contact.id}>
                  <div className={styles.contactIdentity}>
                    <strong>{contact.displayName}</strong>
                    <span>@{contact.handle}</span>
                  </div>
                  <div className={styles.contactActions}>
                    <button type="button" className={styles.inlineButton} onClick={() => { setConfirmRemoveId(null); onSelect(contact); setMessage(`${contact.displayName} added to the draft. Verify the username in Venmo.`); setMessageError(false); }} disabled={disabled || !isCurrent || status !== "ready"} aria-label={`Use ${contact.displayName} in the payment draft`} aria-pressed={selected}>
                      {selected ? "Selected" : "Use"}
                    </button>
                    <button type="button" className={styles.inlineButton} onClick={() => startEdit(contact)} disabled={!canMutate} aria-label={`Edit ${contact.displayName}`}>
                      Edit
                    </button>
                    <button type="button" className={`${styles.inlineButton} ${styles.removeContactButton}`} onClick={() => { setConfirmRemoveId((current) => current === contact.id ? null : contact.id); setMessage(""); setMessageError(false); }} disabled={!canMutate} aria-label={confirmRemoveId === contact.id ? `Cancel removal review for ${contact.displayName}` : `Review removal of ${contact.displayName}`} aria-expanded={confirmRemoveId === contact.id} aria-controls={confirmRemoveId === contact.id ? `venmo-contact-remove-${contact.id}` : undefined}>
                      {confirmRemoveId === contact.id ? "Hide options" : "Remove"}
                    </button>
                  </div>
                  {confirmRemoveId === contact.id && <div id={`venmo-contact-remove-${contact.id}`} className={styles.removeConfirmation} role="group" aria-label={`Confirm removal of ${contact.displayName}`}>
                    <p>Remove <strong>{contact.displayName}</strong> (@{contact.handle}) from this device? This does not change anything in Venmo.</p>
                    <div className={styles.removeConfirmationActions}>
                      <button type="button" className={styles.inlineButton} onClick={() => setConfirmRemoveId(null)} disabled={busy}>Keep contact</button>
                      <button type="button" className={`${styles.inlineButton} ${styles.removeContactButton}`} onClick={() => { void removeContact(contact); }} disabled={!canMutate}>Remove contact</button>
                    </div>
                  </div>}
                </li>;
              })}
            </ul>
          ) : (
            <p className={styles.contactsHint}>Save up to five trusted usernames for faster drafts. Verify each recipient in Venmo before you send.</p>
          )}

          <form className={styles.contactForm} onSubmit={(event) => { void saveContact(event); }}>
            <div className={styles.contactFormHeading}>
              <strong>{editing ? "Edit contact" : "Add a contact"}</strong>
              {editing && <button type="button" className={styles.inlineButton} onClick={cancelEdit} disabled={busy}>Cancel edit</button>}
            </div>
            <div className={styles.contactFormFields}>
              <label className={styles.field} htmlFor="venmo-contact-name">
                <span>Name</span>
                <input
                  id="venmo-contact-name"
                  name="contactName"
                  type="text"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => boundedChange(event, MAX_CONTACT_DISPLAY_NAME_LENGTH * 2, setName, setMessage, "name")}
                  onPaste={(event) => guardPaste(event, MAX_CONTACT_DISPLAY_NAME_LENGTH * 2, setMessage, "name")}
                  placeholder="Display name"
                  aria-label="Contact display name"
                  disabled={!canMutate || (!editing && contacts.length >= MAX_VENMO_CONTACTS)}
                />
              </label>
              <label className={styles.field} htmlFor="venmo-contact-handle">
                <span>Venmo username</span>
                <input
                  id="venmo-contact-handle"
                  name="contactHandle"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={handle}
                  onChange={(event) => boundedChange(event, MAX_CONTACT_HANDLE_LENGTH + 1, setHandle, setMessage, "handle")}
                  onPaste={(event) => guardPaste(event, MAX_CONTACT_HANDLE_LENGTH + 1, setMessage, "handle")}
                  placeholder="@username"
                  aria-label="Venmo username"
                  disabled={!canMutate || (!editing && contacts.length >= MAX_VENMO_CONTACTS)}
                />
              </label>
            </div>
            <div className={styles.contactFormFooter}>
              <small>Names are local labels. Usernames are not checked against Venmo.</small>
              <button className={styles.secondaryButton} type="submit" disabled={!canMutate || (!editing && contacts.length >= MAX_VENMO_CONTACTS)}>
                {busy ? "Saving…" : editing ? "Save changes" : "Save contact"}
              </button>
            </div>
          </form>

          {message && <p className={messageError ? styles.errorMessage : styles.successMessage} role={messageError ? "alert" : "status"} aria-live="polite">{message}</p>}
        </>
      )}
    </section>
  );
}
