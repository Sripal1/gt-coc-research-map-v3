<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import type { Writable } from 'svelte/store';
  import { config } from '../../config/config';
  import iconCancel from '../../imgs/icon-cancel.svg?raw';
  import iconSearch from '../../imgs/icon-search.svg?raw';
  import iconTop from '../../imgs/icon-top.svg?raw';
  import logoUrl from '/logo.ico?url';
  import type { SearchBarStoreValue } from '../../stores';
  import type { SearchWorkerMessage } from '../../types/embedding-types';
  import d3 from '../../utils/d3-import';
  import { displaySearchText } from '../embedding/Embedding';
  import { SearchPanel } from './SearchPanel';

  export let searchPanelStore: Writable<SearchBarStoreValue>;

  // Components
  let component: HTMLElement | null = null;
  let mounted = false;
  let initialized = false;
  let mySearchPanel: SearchPanel | null = null;
  let resultListElement: HTMLElement | null = null;
  let searchInputValue = '';

  // Component states
  let inputFocused = false;
  let searchScrolled = false;
  let showScrollTopButton = false;
  let isModelLoading = true;

  let maxListLength = 100;
  const numberFormatter = d3.format(',');

  // Subscribe to displaySearchText to detect when model finishes loading
  displaySearchText.subscribe(value => {
    if (value === 'Search GT Computing Researchers') {
      isModelLoading = false;
    }
  });

  const searchPanelUpdated = () => {
    mySearchPanel = mySearchPanel;
  };

  onMount(() => {
    mounted = true;
  });

  /**
   * Initialize the embedding view.
   */
  const initView = () => {
    initialized = true;

    if (component && searchPanelStore) {
      mySearchPanel = new SearchPanel(
        component,
        searchPanelUpdated,
        searchPanelStore
      );
    }
  };

  $: mounted && !initialized && component && searchPanelStore && initView();
</script>

<style lang="scss">
  @import './SearchPanel.scss';
</style>

<div class="search-panel-wrapper" bind:this="{component}">
  <div
    class="search-list-container"
    class:shown="{mySearchPanel?.searchBarStoreValue.shown}"
  >
    <div class="search-list">
      <div class="header-gap" class:hidden="{!searchScrolled}"></div>

      {#if mySearchPanel !== null}
        <div
          class="result-list"
          bind:this="{resultListElement}"
          on:scroll="{e => {
            searchScrolled = e.target.scrollTop > 0;
            showScrollTopButton = e.target.scrollTop > 3000;
          }}"
        >
          <div class="count-label">
            {mySearchPanel.searchBarStoreValue.results.length ===
            config.layout.searchLimit
              ? `${config.layout.searchLimit}+`
              : numberFormatter(
                  mySearchPanel.searchBarStoreValue.results.length
                )}
            Search Results
          </div>
          {#each mySearchPanel.formattedResults.slice(0, maxListLength) as result, i}
            <div
              class="item"
              on:keypress="{() => {
                mySearchPanel?.clickHandler(result.point);
              }}"
              on:click="{() => {
                mySearchPanel?.clickHandler(result.point);
              }}"
              on:mouseenter="{() => {
                mySearchPanel?.mouseenterHandler(result.point);
              }}"
              class:clamp-line="{result.isSummary}"
              class:selected="{result.isSelected}"
            >
              {@html result.isSummary ? result.shortText : result.fullText}
              {#if result.scores}
                <div class="similarity-score">
                  Similarity: {(result.scores.semanticScore * 100).toFixed(1)}%
                </div>
              {/if}
            </div>
          {/each}

          <button
            class="add-more-button"
            class:hidden="{mySearchPanel.searchBarStoreValue.results.length <=
              maxListLength}"
            on:click="{() => {
              maxListLength += 100;
            }}"
          >
            <span>Show More</span>
          </button>
        </div>
      {/if}

      <button
        class="scroll-up-button"
        class:hidden="{!showScrollTopButton}"
        on:click="{() => {
          if (resultListElement !== null) {
            resultListElement.scrollTop = 0;
          }
        }}"
      >
        <div class="svg-icon">
          {@html iconTop}
        </div>
        Back to top
      </button>
    </div>
  </div>

  <div class="search-bar" class:focused="{inputFocused}">
    <img src="{logoUrl}" alt="Logo" class="logo-icon" />
    <div class="input-wrapper">
      <input
        type="text"
        id="search-bar-input"
        name="search-query"
        bind:value="{searchInputValue}"
        placeholder=""
        spellcheck="false"
        on:focus="{() => {
          inputFocused = true;
        }}"
        on:blur="{() => {
          inputFocused = false;
        }}"
        on:input="{e => mySearchPanel?.inputChanged(e)}"
      />
      {#if searchInputValue === '' && !inputFocused}
        <div class="placeholder-carousel">
          {#key $displaySearchText}
            <div
              class="placeholder-text"
              in:fly="{{ y: 20, duration: 600, delay: 150 }}"
              out:fly="{{ y: -20, duration: 500 }}"
            >
              {$displaySearchText}
            </div>
          {/key}
        </div>
      {/if}
    </div>

    <div class="end-button">
      <!-- Loading spinner shown while model is loading (even when typing) -->
      <div
        class="spinner"
        class:hidden="{!isModelLoading}"
      ></div>

      <div
        class="svg-icon search-icon"
        class:hidden="{searchInputValue.length !== 0 || isModelLoading}"
      >
        {@html iconSearch}
      </div>

      <button
        class="svg-icon cancel-icon"
        class:hidden="{searchInputValue.length === 0 || isModelLoading}"
        on:click="{() => {
          searchInputValue = '';
          mySearchPanel?.cancelSearch();
        }}"
      >
        {@html iconCancel}
      </button>
    </div>
  </div>
</div>
