<script lang="ts">
  import { onMount } from 'svelte';
  import MapView from './src/components/mapview/MapView.svelte';
  import { UNIVERSITY_NAME, DEPARTMENT_NAME, COLOR_THEME } from './src/config/theme';

  const pageTitle = DEPARTMENT_NAME
    ? `${UNIVERSITY_NAME} ${DEPARTMENT_NAME} Research Map`
    : `${UNIVERSITY_NAME}`;

  onMount(() => {
    document.documentElement.style.setProperty('--color-theme', COLOR_THEME);
  });
</script>

<style></style>

<svelte:head>
  <title>{pageTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Lato&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<div class="stand-alone-page">
  <MapView />
</div>
