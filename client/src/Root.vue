<script setup lang="ts">
import App from "./App.vue";
import LoginGate from "./components/LoginGate.vue";

// Top-level shell: the password gate (feature 0001) wraps the app so App only mounts once
// the client is authenticated (or when no gate is configured).
</script>

<template>
  <LoginGate>
    <App />
  </LoginGate>
</template>
