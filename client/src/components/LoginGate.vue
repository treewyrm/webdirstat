<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";

// Wraps the app: probes the gate on mount, then renders either the login form or, once
// authenticated (or when no gate is configured), the default slot — so the app component
// only mounts past the gate and its startup fetches never hit a 401 (feature 0001).
const { required, authenticated, ready, refresh, submit } = useAuth();

const password = ref("");
const error = ref<string | null>(null);
const pending = ref(false);

onMounted(async () => {
  try {
    await refresh();
  } catch {
    // Server unreachable — treat as "not gated" so the app can surface its own error.
  }
});

async function onSubmit(): Promise<void> {
  error.value = null;
  pending.value = true;
  try {
    await submit(password.value);
    password.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div v-if="!ready" class="gate-splash">…</div>
  <form v-else-if="required && !authenticated" class="gate" @submit.prevent="onSubmit">
    <h1>WebDirStat</h1>
    <label class="field">
      <span>Password</span>
      <input v-model="password" type="password" autofocus autocomplete="current-password" :disabled="pending" />
    </label>
    <button type="submit" :disabled="pending || password.length === 0">
      {{ pending ? "Signing in…" : "Sign in" }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </form>
  <slot v-else />
</template>

<style scoped>
.gate-splash {
  display: grid;
  place-items: center;
  height: 100vh;
  color: var(--muted);
  font-size: 1.5rem;
}

.gate {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  width: min(20rem, 90vw);
  margin: 18vh auto 0;
  padding: 1.6rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}

.gate h1 {
  margin: 0 0 0.2rem;
  font-size: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.field input {
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 0.95rem;
}

.field input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.gate button {
  padding: 0.55rem;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 0.95rem;
  cursor: pointer;
}

.gate button:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
