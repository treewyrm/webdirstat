import { ref } from "vue";
import { fetchSession, login, logout } from "../api";

// Module-level singletons: one shared auth state for the whole app (the gate reads it,
// the toolbar's logout button writes it). Feature 0001.
const required = ref(false);
const authenticated = ref(false);
const ready = ref(false);

/** Shared password-gate state + actions (feature 0001). */
export function useAuth() {
  /** Ask the server whether a gate exists and whether we're already through it. */
  async function refresh(): Promise<void> {
    const info = await fetchSession();
    required.value = info.required;
    authenticated.value = info.authenticated;
    ready.value = true;
  }

  /** Log in with the shared password; on success the app mounts. Throws on bad password. */
  async function submit(password: string): Promise<void> {
    await login(password);
    authenticated.value = true;
  }

  /** Log out and drop back to the gate. */
  async function signOut(): Promise<void> {
    await logout();
    authenticated.value = false;
  }

  return { required, authenticated, ready, refresh, submit, signOut };
}
