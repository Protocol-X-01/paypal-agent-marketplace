import { CustomerSessionError, type createCustomerSessionClient, type ValidatedNativeSession } from './customer-session-client';
import type { createCustomerSessionStorage, CustomerAuthSnapshot, CustomerAuthStorageResult } from './customer-session-storage';
import { parseCustomerSessionReturnUrl, validateCustomerAuthorizationUrl, validateCustomerSessionLinkConfig, type CustomerSessionLinkConfig, type NativePlatform } from './customer-session-links';

type Client = ReturnType<typeof createCustomerSessionClient>;
type Storage = ReturnType<typeof createCustomerSessionStorage>;
type SignOutTransition = { epoch: number; preparePrivacyHold(): void; notify(): void };
type UnconfirmedHandoff = { handoff: string; codeVerifier: string; client: Client };
type SignOutGroup = { required: boolean; signInRecovery: boolean; logoutRevision: object; pending?: Promise<void>; signIn?: Promise<void>; members: Set<() => SignOutTransition>; inFlight: Set<Promise<void>>; unconfirmedHandoffs: UnconfirmedHandoff[] };
const signOutGroups = new WeakMap<object, SignOutGroup>();
export type CustomerSessionManagerState = Readonly<{ status: 'holding' | 'guest' } | { status: 'authenticated'; identity: Readonly<ValidatedNativeSession> }>;
export type CustomerSessionManagerDependencies = {
  client: Client; storage: Storage; platform: NativePlatform;
  secrets(): Promise<{ state: string; codeVerifier: string; codeChallenge: string; codeChallengeMethod: 'S256' }>;
  openBrowser(input: { authorizationUrl: string; handoff: string; state: string }): Promise<{ type: 'success'; url: string } | { type: 'cancel' | 'dismiss' }>;
  dismissBrowser?: () => void | Promise<void>;
  canStartSignIn?: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Must synchronously hold its runtime's private scope without notifying observers. */
  preparePrivacyHold?: () => void;
};
/** Pure lifecycle coordinator. A disabled runtime must separately inspect secure
 * storage presence before permitting guest mode; never construct this with a
 * guessed configuration. Subscribe exposes identity only, never stored secrets. */
export function createCustomerSessionManager(config: CustomerSessionLinkConfig, deps: CustomerSessionManagerDependencies) {
  const checked = validateCustomerSessionLinkConfig(config);
  const now = deps.now ?? Date.now, setTimer = deps.setTimer ?? setTimeout, clearTimer = deps.clearTimer ?? clearTimeout;
  let state: CustomerSessionManagerState = Object.freeze({ status: 'holding' });
  let generation = 0, queue = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined;
  let interruptBrowser: (() => void) | undefined, disposed = false, foreground = true, busy = 0, checkingCapability = false;
  const listeners = new Set<(value: CustomerSessionManagerState) => void>();
  const identity = deps.storage.coordinationIdentity();
  let group = signOutGroups.get(identity);
  if (!group) { group = { required: false, signInRecovery: false, logoutRevision: {}, members: new Set(), inFlight: new Set(), unconfirmedHandoffs: [] }; signOutGroups.set(identity, group); }
  const signOut = group;
  function publish(next: CustomerSessionManagerState) {
    if (disposed || (signOut.required && next.status === 'authenticated')) return;
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    state = Object.freeze(next.status === 'authenticated' ? { status: next.status, identity: Object.freeze({ ...next.identity }) } : next);
    for (const listener of listeners) { try { listener(state); } catch { /* UI observers cannot alter authentication. */ } }
    if (state.status === 'authenticated') timer = setTimer(() => suspend(), Math.max(0, state.identity.expiresAt - now()));
  }
  function suspendAndCapture() {
    const epoch = ++generation; interruptBrowser?.(); interruptBrowser = undefined;
    publish({ status: 'holding' });
    return epoch;
  }
  function suspend() {
    // A reserved sign-out already holds every manager. Do not invalidate its
    // accepted cleanup when a screen or foreground transition also suspends.
    if (!disposed && !signOut.pending) suspendAndCapture();
  }
  function prepareSharedHold(): SignOutTransition {
    const epoch = ++generation, interrupt = interruptBrowser, previousTimer = timer;
    interruptBrowser = undefined; timer = undefined;
    // All managers are held before any observer can reenter sign-in or restore.
    state = Object.freeze({ status: 'holding' });
    return { epoch, preparePrivacyHold() { deps.preparePrivacyHold?.(); }, notify() {
      if (previousTimer !== undefined) { try { clearTimer(previousTimer); } catch { /* Continue holding other observers. */ } }
      try { interrupt?.(); } catch { /* Continue holding other observers. */ }
      if (!disposed) for (const listener of listeners) { try { listener(state); } catch { /* Observer isolation. */ } }
    } };
  }
  signOut.members.add(prepareSharedHold);
  async function browser(input: Parameters<CustomerSessionManagerDependencies['openBrowser']>[0]) {
    let rejectWait: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => { rejectWait = () => {
      try { void Promise.resolve(deps.dismissBrowser?.()).catch(() => {}); } catch { /* Best effort native dismissal. */ }
      reject(new Error('Sign-in interrupted.'));
    }; });
    interruptBrowser = rejectWait;
    try { return await Promise.race([deps.openBrowser(input), interrupted]); }
    finally { if (interruptBrowser === rejectWait) interruptBrowser = undefined; }
  }
  function assertCurrent(epoch: number, acceptedSignOut = false) {
    if ((disposed && !acceptedSignOut) || generation !== epoch || (signOut.required && !acceptedSignOut)) throw new Error('Sign-in interrupted.');
  }
  function ready(result: CustomerAuthStorageResult): CustomerAuthSnapshot { if (result.status !== 'ready') throw new Error('Sign-in storage unavailable.'); return result.snapshot; }
  const read = async () => ready(await deps.storage.read());
  function run(work: (epoch: number) => Promise<void>, epoch: number, acceptedSignOut = false): Promise<void> {
    busy++;
    const result = queue.then(async () => { assertCurrent(epoch, acceptedSignOut); await work(epoch); }).catch(() => { if (generation === epoch) publish({ status: 'holding' }); }).finally(() => { busy--; });
    signOut.inFlight.add(result);
    void result.then(() => signOut.inFlight.delete(result), () => signOut.inFlight.delete(result));
    queue = result; return result;
  }
  async function cleanup(base: CustomerAuthSnapshot, epoch: number, all: boolean, acceptedSignOut = false): Promise<CustomerAuthSnapshot> {
    const check = () => assertCurrent(epoch, acceptedSignOut);
    check();
    // Interrupted sign-in may already have issued a family. Revoke any candidate
    // too; cancellation can invalidate its rotated predecessor or successor.
    const removeSession = all || base.value.pending !== null || base.value.revocations.length > 0;
    if (base.value.pending && !base.value.pending.handoff) base = ready(await deps.storage.discardUnboundPending(base));
    if (removeSession && base.value.session) base = ready(await deps.storage.queueSessionRevocation(base));
    check();
    if (base.value.pending?.handoff && !base.value.revocations.some(r => r.kind === 'handoff')) base = ready(await deps.storage.queueHandoffCancellation(base));
    for (const retry of [...base.value.revocations]) {
      check();
      if (retry.kind === 'session') { await deps.client.logout(retry.sessionToken); check(); base = ready(await deps.storage.confirmSessionRevoked(base, retry.sessionToken)); }
      else { await deps.client.cancel({ handoff: retry.handoff, codeVerifier: retry.codeVerifier }); check(); base = ready(await deps.storage.confirmHandoffCancelled(base, retry.handoff)); }
    }
    check(); return base;
  }
  async function authenticate(base: CustomerAuthSnapshot, token: string, epoch: number) {
    const identity = await deps.client.session(token); assertCurrent(epoch);
    base = ready(await deps.storage.saveVerifiedSession(base, token, identity)); assertCurrent(epoch);
    base = ready(await deps.storage.finishVerifiedSignIn(base)); assertCurrent(epoch);
    if (base.value.revocations.length || !base.value.session || identity.expiresAt <= now()) throw new Error('Sign-in unavailable.');
    if (foreground) publish({ status: 'authenticated', identity });
  }
  function restore(retryFailedSignOut = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (signOut.pending) return signOut.pending.then(() => { if (!disposed && (!signOut.required || retryFailedSignOut)) return restore(retryFailedSignOut); });
    if (signOut.signIn) return signOut.signIn.then(() => { if (!disposed && (!signOut.signInRecovery || retryFailedSignOut)) return restore(retryFailedSignOut); });
    // A failed sign-out remains a privacy hold across manager remounts. The
    // regular Check session action retries cleanup before any authentication.
    if (signOut.required || signOut.signInRecovery) return retryFailedSignOut ? logout() : Promise.resolve();
    if (signOut.unconfirmedHandoffs.length) return logout();
    const epoch = suspendAndCapture();
    return run(async epoch => {
      const base = await cleanup(await read(), epoch, false); assertCurrent(epoch);
      if (!base.value.session) publish({ status: 'guest' });
      else {
        try { await authenticate(base, base.value.session.sessionToken, epoch); }
        catch (error) {
          assertCurrent(epoch);
          if (!(error instanceof CustomerSessionError) || error.code !== 'unauthorized') throw error;
          // A session401 is not revocation proof. Persist retry material, then
          // require authoritative logout204 and confirmed local readback.
          const cleared = await cleanup(await read(), epoch, true); assertCurrent(epoch);
          if (!cleared.value.session && !cleared.value.pending && !cleared.value.revocations.length) publish({ status: 'guest' });
        }
      }
    }, epoch);
  }
  function logout(): Promise<void> {
    if (signOut.pending) return signOut.pending;
    if (disposed) return Promise.resolve();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    // Reserve before invoking any observer. Other managers join this operation.
    signOut.required = true; signOut.pending = pending; signOut.logoutRevision = {};
    // Capture before enqueueing the cleanup itself. A retired manager may still
    // be receiving a handoff and must preserve its proof before cleanup reads.
    const previousWork = [...signOut.inFlight];
    const transitions = [...signOut.members].map(member => ({ member, transition: member() }));
    const epoch = transitions.find(item => item.member === prepareSharedHold)!.transition.epoch;
    let preparationFailed = false;
    for (const { transition } of transitions) { try { transition.preparePrivacyHold(); } catch { preparationFailed = true; } }
    for (const { transition } of transitions) transition.notify();
    let completed = false;
    const work = run(async epoch => {
      await Promise.all(previousWork); assertCurrent(epoch, true);
      // Attachment failure can mean either no write or an applied write with
      // lost readback. Retain the received proof until cancellation confirms.
      for (const proof of [...signOut.unconfirmedHandoffs]) {
        await proof.client.cancel({ handoff: proof.handoff, codeVerifier: proof.codeVerifier }); assertCurrent(epoch, true);
        const index = signOut.unconfirmedHandoffs.indexOf(proof);
        if (index !== -1) signOut.unconfirmedHandoffs.splice(index, 1);
      }
      const base = await cleanup(await read(), epoch, true, true); assertCurrent(epoch, true);
      if (!preparationFailed && !base.value.session && !base.value.pending && !base.value.revocations.length) { completed = true; publish({ status: 'guest' }); }
    }, epoch, true);
    void work.then(() => {
      if (signOut.pending === pending) { signOut.pending = undefined; if (completed) { signOut.required = false; signOut.signInRecovery = false; } }
      finish();
    });
    return pending;
  }
  function canBeginStart(): boolean {
    return !disposed && !signOut.required && !signOut.signInRecovery && !signOut.signIn && !signOut.unconfirmedHandoffs.length && busy === 0 && !checkingCapability && state.status !== 'holding';
  }
  function start() {
    // Ignore repeated taps before they can suspend the active generation or
    // dismiss its browser. Explicit cancel/logout still interrupt the attempt.
    if (!canBeginStart()) return Promise.resolve();
    // Capability denial must not create pending material or interrupt an existing session.
    let capable = false;
    checkingCapability = true;
    try { capable = !deps.canStartSignIn || deps.canStartSignIn(); } catch { /* Capability is unavailable. */ }
    finally { checkingCapability = false; }
    // A capability callback can reenter the manager. Respect any sign-out,
    // hold, disposal, or other operation accepted during that callback.
    if (!capable || !canBeginStart()) return Promise.resolve();
    const previous = state.status;
    let finish!: () => void;
    const signIn = new Promise<void>(resolve => { finish = resolve; });
    // A successful sign-in can rotate the owner. Hold every runtime before
    // observers can act on another runtime's previous account or guest scope.
    signOut.signIn = signIn;
    const logoutRevision = signOut.logoutRevision;
    const previousWork = [...signOut.inFlight];
    const transitions = [...signOut.members].map(member => ({ member, transition: member() }));
    const epoch = transitions.find(item => item.member === prepareSharedHold)!.transition.epoch;
    let preparationFailed = false;
    for (const { transition } of transitions) { try { transition.preparePrivacyHold(); } catch { preparationFailed = true; } }
    for (const { transition } of transitions) transition.notify();
    let completed = false;
    const work = run(async epoch => {
      await Promise.all(previousWork); assertCurrent(epoch);
      if (preparationFailed) throw new Error('Sign-in unavailable.');
      if (previous !== 'guest' && previous !== 'authenticated') throw new Error('Restore sign-in first.');
      let base = await read(); assertCurrent(epoch);
      if (base.value.pending || base.value.revocations.length || !(await deps.client.availability()).loginAvailable) throw new Error('Sign-in unavailable.');
      assertCurrent(epoch);
      const secrets = await deps.secrets(); assertCurrent(epoch);
      base = ready(await deps.storage.savePending(base, { state: secrets.state, codeVerifier: secrets.codeVerifier })); assertCurrent(epoch);
      const handoff = await deps.client.createHandoff({ state: secrets.state, codeChallenge: secrets.codeChallenge, codeChallengeMethod: secrets.codeChallengeMethod, platform: deps.platform }, base.value.session?.sessionToken);
      // Always persist a received handle, even if superseded during creation, so
      // queued cleanup can revoke it. No browser opens until this readback succeeds.
      let attached: CustomerAuthStorageResult;
      try { attached = await deps.storage.savePending(base, { state: secrets.state, codeVerifier: secrets.codeVerifier, handoff: handoff.handoff }); }
      catch (error) {
        signOut.unconfirmedHandoffs.push({ handoff: handoff.handoff, codeVerifier: secrets.codeVerifier, client: deps.client });
        throw error;
      }
      if (attached.status !== 'ready') signOut.unconfirmedHandoffs.push({ handoff: handoff.handoff, codeVerifier: secrets.codeVerifier, client: deps.client });
      base = ready(attached); assertCurrent(epoch);
      const authorizationUrl = validateCustomerAuthorizationUrl(handoff.authorizationUrl, handoff.handoff, checked);
      const result = await browser({ authorizationUrl, handoff: handoff.handoff, state: secrets.state }); assertCurrent(epoch);
      if (result.type !== 'success') {
        const cleared = await cleanup(base, epoch, true); assertCurrent(epoch);
        if (cleared.value.session || cleared.value.pending || cleared.value.revocations.length) throw new Error('Sign-in unavailable.');
        completed = true; publish({ status: 'guest' }); return;
      }
      const returned = parseCustomerSessionReturnUrl(result.url, deps.platform, secrets.state, checked);
      const exchanged = await deps.client.exchange({ handoff: handoff.handoff, code: returned.code, state: returned.state, codeVerifier: secrets.codeVerifier }); assertCurrent(epoch);
      await authenticate(base, exchanged.sessionToken, epoch); completed = true;
    }, epoch);
    void work.then(() => {
      if (signOut.signIn === signIn) signOut.signIn = undefined;
      if (!completed && signOut.logoutRevision === logoutRevision) signOut.signInRecovery = true;
      finish();
    });
    return signIn;
  }
  return {
    getState(): CustomerSessionManagerState { if (state.status === 'authenticated' && state.identity.expiresAt <= now()) suspend(); return state; },
    subscribe(listener: (value: CustomerSessionManagerState) => void) { if (state.status === 'authenticated' && state.identity.expiresAt <= now()) suspend(); listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    isBusy() { return busy > 0; },
    /** The system authentication browser backgrounds this app normally. Keep its
     * held sign-in generation alive, but never reveal identity while inactive. */
    setForeground(active: boolean): Promise<void> {
      foreground = active;
      if (!active) { if (state.status === 'authenticated') suspend(); return Promise.resolve(); }
      if (signOut.pending || signOut.required) return restore();
      if (busy === 0) return restore();
      const epoch = generation;
      return queue.then(() => {
        // Foreground can arrive after background persistence but before the
        // current operation's finalizer releases its busy count.
        if (!disposed && foreground && generation === epoch && state.status === 'holding') return restore();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; signOut.members.delete(prepareSharedHold); listeners.clear();
      // Once accepted, sign-out cleanup may finish after unmount while JS runs.
      if (!signOut.pending) generation++;
      interruptBrowser?.(); interruptBrowser = undefined;
      if (timer !== undefined) { clearTimer(timer); timer = undefined; }
      state = Object.freeze({ status: 'holding' });
    },
    suspend, restore, start, logout,
    cancel: logout,
    retryCleanup: logout,
  };
}
