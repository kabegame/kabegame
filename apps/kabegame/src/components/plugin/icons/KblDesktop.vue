<template>
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="kbl-desk" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0" stop-color="#9BDCFF" />
        <stop offset="1" stop-color="#5B7CF6" />
      </linearGradient>
    </defs>
    <rect x="9.4" y="15.6" width="5.2" height="3.6" fill="#4F5BD5" />
    <rect x="6.6" y="18.6" width="10.8" height="1.8" rx="0.9" fill="#4F5BD5" />
    <rect x="1.8" y="3.6" width="20.4" height="13.2" rx="2" fill="#4F5BD5" />
    <rect x="3.3" y="5.1" width="17.4" height="10.2" rx="1" fill="url(#kbl-desk)" />
    <circle cx="7.2" cy="8.4" r="1.5" fill="#FFE7A0" />
    <path d="M3.3 15.3v-2.2l3.6-3.1 3 2.6 3.4-3.7 7.4 6.4z" fill="#3F5FD6" opacity="0.5" />
  </svg>
</template>

<script lang="ts" setup>
defineOptions({
  name: "KblDesktop",
});
</script>
