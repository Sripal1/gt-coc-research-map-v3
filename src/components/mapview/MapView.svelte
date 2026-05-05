<script lang="ts">
  import type { PromptPoint } from 'src/types/embedding-types';
  import { onMount } from 'svelte';
  import { getFooterStore, getSearchBarStore } from '../../stores';
  import Embedding from '../embedding/Embedding.svelte';
  import Footer from '../footer/Footer.svelte';
  import SearchPanel from '../search-panel/SearchPanel.svelte';

  let component: HTMLElement | null = null;
  let datasetName = 'aimap_researchers';
  let dataURL: string | null = null;
  let gridURL: string | null = null;
  let notebookMode = false;
  $: points = $footerStore.promptPoints || [];
  let displaySummaryPoint: PromptPoint | null = null;

  // Check url query to change dataset names
  if (window.location.search !== '') {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.has('dataset')) {
      datasetName = searchParams.get('dataset')!;
    }

    if (searchParams.has('dataURL') && searchParams.has('gridURL')) {
      dataURL = searchParams.get('dataURL') as string;
      gridURL = searchParams.get('gridURL') as string;
      // console.log(dataURL, gridURL);
    }
  }

  if (import.meta.env.MODE === 'notebook') {
    notebookMode = true;
  }

  // Create stores for child components to consume
  const footerStore = getFooterStore();
  const searchBarStore = getSearchBarStore();

  onMount(() => {
    console.log('Base URL:', import.meta.env.BASE_URL);
    console.log('Mode:', import.meta.env.MODE);
    console.log('Data URL:', dataURL);
    console.log('Grid URL:', gridURL);
  });
</script>

<style lang="scss">
  @import './MapView.scss';
</style>

<div class="mapview-page">
  <div id="popper-tooltip-top" class="popper-tooltip hidden" role="tooltip">
    <span class="popper-content"></span>
    <div class="popper-arrow"></div>
  </div>

  <div id="popper-tooltip-clicked" class="popper-tooltip hidden" role="tooltip">
    <span class="popper-content"></span>
    <div class="popper-arrow"></div>
  </div>

  <div id="popper-tooltip-bottom" class="popper-tooltip hidden" role="tooltip">
    <span class="popper-content"></span>
    <div class="popper-arrow"></div>
  </div>

  <div class="app-wrapper">
    <div class="main-app-container">
      <Embedding
        {datasetName}
        {dataURL}
        {gridURL}
        {footerStore}
        {searchBarStore}
        {notebookMode}
      />
    </div>
  </div>

  <div class="footer-container">
    <Footer {footerStore} />
  </div>

  <div class="search-panel-container">
    <SearchPanel searchPanelStore="{searchBarStore}" />
  </div>
</div>
