<script lang="ts">
  import DOMPurify from 'dompurify';
  import { onDestroy, onMount } from 'svelte';
  import type { Writable } from 'svelte/store';
  import iconCaret from '../../imgs/icon-caret-down.svg?raw';
  import iconClose from '../../imgs/icon-close.svg?raw';
  import iconContour from '../../imgs/icon-contour.svg?raw';
  import iconGrid from '../../imgs/icon-grid.svg?raw';
  import iconInfo from '../../imgs/icon-info.svg?raw';
  import iconLabel from '../../imgs/icon-label.svg?raw';
  import iconPause from '../../imgs/icon-pause-solid.svg?raw';
  import iconPlay from '../../imgs/icon-play-solid.svg?raw';
  import iconPoint from '../../imgs/icon-point.svg?raw';
  import iconTime from '../../imgs/icon-time.svg?raw';
  import type { FooterStoreValue, SearchBarStoreValue } from '../../stores';
  import type { NotebookEvent } from '../../types/common-types';
  import type {
    DataURLs,
    EmbeddingInitSetting
  } from '../../types/embedding-types';
  import { allTrue, anyTrue } from '../../utils/utils';
  import { Embedding } from './Embedding';
  import { currClickedPoint, currHoveredPoint } from './EmbeddingPointWebGL';

  let component: HTMLElement | null = null;
  let mounted = false;
  let initialized = false;
  let myEmbedding: Embedding | null = null;
  let controlDisplayItem = '';
  let shouldShowLabelControls = true;

  const defaultSetting: EmbeddingInitSetting = {
    showContour: true,
    showPoint: true,
    showGrid: false,
    showLabel: true
  };

  export let datasetName: string;
  export let dataURL: string | null = null;
  export let gridURL: string | null = null;
  export let footerStore: Writable<FooterStoreValue>;
  export let searchBarStore: Writable<SearchBarStoreValue>;
  export let notebookMode: boolean;

  // Resolve the embedding data files based on the embedding
  let DATA_BASE = `${import.meta.env.BASE_URL}data`;
  if (import.meta.env.MODE === 'github') {
    DATA_BASE = 'https://pub-596951ee767949aba9096a18685c74bd.r2.dev';
  }
  const HF_BASE =
    'https://huggingface.co/datasets/xiaohk/embeddings/resolve/main';

  const dataURLs: DataURLs = {
    point: '',
    grid: ''
  };

  switch (datasetName) {
    case 'diffusiondb': {
      // dataURLs.point = DATA_BASE + '/diffusiondb/umap-mini.ndjson';
      dataURLs.point = DATA_BASE + '/diffusiondb/umap.ndjson';
      dataURLs.grid = DATA_BASE + '/diffusiondb/grid.json';
      break;
    }

    case 'acl-abstracts': {
      dataURLs.point = DATA_BASE + '/acl-abstracts/umap.ndjson';
      dataURLs.grid = DATA_BASE + '/acl-abstracts/grid.json';
      break;
    }

    case 'imdb': {
      dataURLs.point = HF_BASE + '/imdb/data.ndjson';
      dataURLs.grid = HF_BASE + '/imdb/grid.json';
      break;
    }

    case 'temp': {
      dataURLs.point = DATA_BASE + '/temp/data.ndjson';
      dataURLs.grid = DATA_BASE + '/temp/grid.json';
      break;
    }

    case 'aimap_researchers': {
      if (import.meta.env.MODE === 'actions') {
        // Actions build: data bundled locally by the pipeline
        dataURLs.point = DATA_BASE + '/data.ndjson';
        dataURLs.grid = DATA_BASE + '/grid.json';
      } else if (import.meta.env.MODE === 'github' || import.meta.env.MODE === 'production') {
        // Production builds: fetch from HuggingFace
        dataURLs.point =
          'https://huggingface.co/datasets/techkid673/aimap-data/resolve/main/data.ndjson';
        dataURLs.grid =
          'https://huggingface.co/datasets/techkid673/aimap-data/resolve/main/grid.json';
      } else {
        // Dev mode: use local data files
        dataURLs.point = DATA_BASE + '/aimap_researchers/data.ndjson';
        dataURLs.grid = DATA_BASE + '/aimap_researchers/grid.json';
      }
      break;
    }

    default: {
      console.error(`Unknown dataset name: ${datasetName}`);
    }
  }

  // If dataURL and gridURL are given, use them to override the default dataset
  if (dataURL && gridURL) {
    dataURLs.point = dataURL;
    dataURLs.grid = gridURL;
  }

  onMount(() => {
    mounted = true;
  });

  onDestroy(() => {
    if (myEmbedding) {
      myEmbedding.cleanup();
    }
  });

  const updateEmbedding = () => {
    myEmbedding = myEmbedding;
  };

  const displayCheckboxChanged = (
    e: Event,
    checkbox: string,
    group: string | undefined = undefined
  ) => {
    const target = e.target as HTMLInputElement;
    if (!target) return;
    const newValue = target.checked;
    myEmbedding?.displayCheckboxChanged(checkbox, newValue, group);
  };

  const handleSliderInput = (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (!target) return;
    if (
      myEmbedding &&
      typeof myEmbedding.labelNumSliderChanged === 'function'
    ) {
      myEmbedding.labelNumSliderChanged(e as InputEvent);
    }
  };

  /**
   * Initialize the embedding view.
   */
  const initView = () => {
    initialized = true;

    if (component) {
      myEmbedding = new Embedding({
        component,
        updateEmbedding,
        defaultSetting,
        dataURLs,
        footerStore,
        searchBarStore
      });
    }
  };

  //print out hovered point
  $: if ($currClickedPoint != null || $currHoveredPoint != null) {
    controlDisplayItem = 'resInfo';
  }

  // If it is notebook mode, we don't init the view until we get users' URLs
  if (notebookMode) {
    document.addEventListener('wizmapData', (e: Event) => {
      const notebookEvent = e as NotebookEvent;
      dataURLs.point = notebookEvent.dataURL;
      dataURLs.grid = notebookEvent.gridURL;
      initView();
    });
  }
  // <img class="tooltip-res-image" src="${point.currURL}">

  $: mounted && !initialized && component && !notebookMode && initView();

  // $: console.log('curr hovered point ' + $currHoveredPoint + ' ');

  // $: console.log(
  //   'curr clicked point ' + ($currHoveredPoint + ' ' + $currClickedPoint) + ' '
  // );

  $: currentPoint = $currHoveredPoint || $currClickedPoint;
  $: homepage = currentPoint?.homePageURL;

  // Calculate if label controls should be shown based on zoom level
  $: {
    const relativeZoom = $footerStore.curZoomTransform.k / $footerStore.initZoomK;
    shouldShowLabelControls = relativeZoom < 0.5 || relativeZoom > 1.5;

    // Close the label dropdown if it becomes hidden
    if (!shouldShowLabelControls && controlDisplayItem === 'label') {
      controlDisplayItem = '';
    }
  }

  // $: console.log('Reactive homepage: ' + homepage);
</script>

<style lang="scss">
  @import './Embedding.scss';

  .scrollable-tooltip {
    max-height: 300px;
    overflow-y: auto;
    padding-right: 10px;
  }

  .scrollable-tooltip::-webkit-scrollbar {
    width: 6px;
  }

  .scrollable-tooltip::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 3px;
  }

  .scrollable-tooltip::-webkit-scrollbar-thumb {
    background: #888;
    border-radius: 3px;
  }

  .scrollable-tooltip::-webkit-scrollbar-thumb:hover {
    background: #555;
  }
</style>

<div class="embedding-wrapper" bind:this="{component}">
  <div class="grab-blocker"></div>
  <div class="embedding">
    <svg class="top-svg"></svg>
    <canvas class="search-point-canvas hidden"></canvas>
    <canvas class="embedding-canvas"></canvas>
    <canvas class="embedding-canvas-back"></canvas>
    <canvas class="topic-grid-canvas top"></canvas>
    <canvas class="topic-grid-canvas bottom"></canvas>
    <svg class="embedding-svg"></svg>
  </div>

  <div class="control-bar">
    <button
      class="item-wrapper"
      on:click="{() => {
        if (!myEmbedding || myEmbedding.groupNames === null) {
          myEmbedding?.displayCheckboxChanged(
            'contour',
            !myEmbedding.showContours[0]
          );
        } else {
          if (controlDisplayItem === 'contour') {
            controlDisplayItem = '';
          } else {
            if (controlDisplayItem === 'time') {
              myEmbedding?.displayCheckboxChanged('time', false);
            }
            controlDisplayItem = 'contour';
          }
        }
      }}"
    >
      <div
        class="item"
        class:activated="{myEmbedding
          ? anyTrue(myEmbedding.showContours)
          : false}"
      >
        <div class="svg-icon">{@html iconContour}</div>
        <div class="name">Contours</div>
        <div
          class="caret"
          class:hidden="{!myEmbedding || myEmbedding.groupNames === null}"
          class:activated="{controlDisplayItem === 'contour'}"
        >
          <div class="svg-icon">
            {@html iconCaret}
          </div>
        </div>
      </div>

      {#if myEmbedding?.groupNames !== null}
        <button
          class="menu contour-menu"
          class:hidden="{controlDisplayItem !== 'contour'}"
          on:click="{e => {
            e.stopPropagation();
          }}"
        >
          <div class="control-row">
            <input
              type="checkbox"
              class="checkbox"
              id="checkbox-contour-1"
              name="checkbox-contour-1"
              checked="{defaultSetting.showContour}"
              on:input="{e =>
                displayCheckboxChanged(
                  e,
                  'contour',
                  myEmbedding?.groupNames[0]
                )}"
            />
            <label for="checkbox-contour-1">{myEmbedding?.groupNames[0]}</label>
          </div>

          <div class="control-row">
            <input
              type="checkbox"
              class="checkbox"
              id="checkbox-contour-2"
              name="checkbox-contour-2"
              checked="{false}"
              on:input="{e =>
                displayCheckboxChanged(
                  e,
                  'contour',
                  myEmbedding?.groupNames[1]
                )}"
            />
            <label for="checkbox-contour-2">{myEmbedding?.groupNames[1]}</label>
          </div>
        </button>
      {/if}
    </button>
    <div class="flex-gap"></div>

    <button
      class="item-wrapper"
      on:click="{() => {
        if (!myEmbedding || myEmbedding.groupNames === null) {
          // Toggle visibility of all points when clicking the Point button
          const pointsVisible = myEmbedding?.showPoints[0];
          myEmbedding?.displayCheckboxChanged('point', !pointsVisible);
          const labelSummariesVisible = myEmbedding?.labelSummariesVisible;
          myEmbedding?.showLabelSummaries(!labelSummariesVisible);

          // Add this code to directly hide/show the SVG points with animation
          const pointGroup = document.querySelector('g.points');
          if (pointGroup) {
            if (pointsVisible) {
              pointGroup.classList.add('hidden');
            } else {
              pointGroup.classList.remove('hidden');
            }
          }
        } else {
          if (controlDisplayItem === 'point') {
            controlDisplayItem = '';
          } else {
            if (controlDisplayItem === 'time') {
              myEmbedding?.displayCheckboxChanged('time', false);
            }
            controlDisplayItem = 'point';
          }
          const labelSummariesVisible = myEmbedding?.labelSummariesVisible;

          myEmbedding?.showLabelSummaries(!labelSummariesVisible);
        }
      }}"
    >
      <div
        class="item"
        class:activated="{myEmbedding
          ? anyTrue(myEmbedding.showPoints)
          : false}"
      >
        <div class="svg-icon">{@html iconPoint}</div>
        <div class="name">Researchers</div>
        <div
          class="caret"
          class:hidden="{!myEmbedding || myEmbedding.groupNames === null}"
          class:activated="{controlDisplayItem === 'point'}"
        >
          <div class="svg-icon">
            {@html iconCaret}
          </div>
        </div>
      </div>

      {#if myEmbedding?.groupNames !== null}
        <button
          class="menu point-menu"
          class:hidden="{controlDisplayItem !== 'point'}"
          on:click="{e => {
            e.stopPropagation();
          }}"
        >
          <div class="control-row">
            <input
              type="checkbox"
              class="checkbox"
              id="checkbox-point-1"
              name="checkbox-point-1"
              checked="{defaultSetting.showPoint}"
              on:input="{e =>
                displayCheckboxChanged(e, 'point', myEmbedding?.groupNames[0])}"
            />
            <label for="checkbox-point-1">{myEmbedding?.groupNames[0]}</label>
          </div>

          <div class="control-row">
            <input
              type="checkbox"
              class="checkbox"
              id="checkbox-point-2"
              name="checkbox-point-2"
              checked="{false}"
              on:input="{e =>
                displayCheckboxChanged(e, 'point', myEmbedding?.groupNames[1])}"
            />
            <label for="checkbox-point-2">{myEmbedding?.groupNames[1]}</label>
          </div>
        </button>
      {/if}
    </button>
    <div class="flex-gap"></div>

    <button
      class="item-wrapper"
      on:click="{() => {
        if (defaultSetting.showGrid) {
          defaultSetting.showGrid = false;
          myEmbedding?.displayCheckboxChanged('grid', false);
        } else {
          defaultSetting.showGrid = true;
          myEmbedding?.displayCheckboxChanged('grid', true);
        }
      }}"
    >
      <div class="item" class:activated="{defaultSetting.showGrid}">
        <div class="svg-icon">{@html iconGrid}</div>
        <div class="name">Grid</div>
      </div>
    </button>
    <div class="flex-gap"></div>

    <button
      class="item-wrapper"
      class:hidden="{!shouldShowLabelControls}"
      on:click="{() => {
        if (controlDisplayItem === 'label') {
          controlDisplayItem = '';
        } else {
          if (controlDisplayItem === 'time') {
            myEmbedding?.displayCheckboxChanged('time', false);
          }
          controlDisplayItem = 'label';
        }
      }}"
    >
      <div class="item" class:activated="{defaultSetting.showLabel}">
        <div class="svg-icon">{@html iconLabel}</div>
        <div class="name">Research Areas</div>
        <div class="caret" class:activated="{controlDisplayItem === 'label'}">
          <div class="svg-icon">
            {@html iconCaret}
          </div>
        </div>
      </div>

      <button
        class="menu label-menu"
        class:hidden="{controlDisplayItem !== 'label'}"
        on:click="{e => {
          e.stopPropagation();
        }}"
      >
        <div class="control-item">
          <div class="item-header">Automatic Labeling</div>

          <div class="control-row">
            <input
              type="checkbox"
              class="checkbox"
              id="checkbox-label"
              name="checkbox-label"
              bind:checked="{defaultSetting.showLabel}"
              on:input="{e => displayCheckboxChanged(e, 'label')}"
            />
            <label for="checkbox-label">High Density Regions</label>
          </div>
        </div>

        <div class="control-item slider-item">
          <div class="control-row">
            <label class="slider-label" for="slider-label-num"
              >Number of Research Areas</label
            >
            <span class="slider-count">0</span>
          </div>

          <input
            type="range"
            class="slider"
            id="slider-label-num"
            name="label-num"
            disabled="{!defaultSetting.showLabel}"
            min="0"
            max="0"
            on:input="{handleSliderInput}"
          />
        </div>
      </button>
    </button>

    <div class="flex-bigger-gap"></div>
    <div class="flex-gap"></div>

    <button
      class="item-wrapper"
      disabled="{myEmbedding ? myEmbedding.timeCountMap === null : true}"
      on:click="{() => {
        if (controlDisplayItem === 'time') {
          controlDisplayItem = '';
          myEmbedding?.displayCheckboxChanged('time', false);
        } else {
          controlDisplayItem = 'time';
          myEmbedding?.displayCheckboxChanged('time', true);
        }
      }}"
    >
      <button class="item" class:activated="{controlDisplayItem === 'time'}">
        <div class="svg-icon">{@html iconTime}</div>
        <div class="name">Time</div>
        <div class="caret" class:activated="{controlDisplayItem === 'time'}">
          <div class="svg-icon">
            {@html iconCaret}
          </div>
        </div>
      </button>

      <button
        class="menu time-menu"
        class:hidden="{controlDisplayItem !== 'time'}"
        on:click="{e => {
          e.stopPropagation();
        }}"
      >
        <div class="control-row">
          <div class="play-pause-button">
            <button
              class="svg-icon"
              class:hidden="{myEmbedding
                ? myEmbedding.playingTimeSlider
                : false}"
            >
              {@html iconPlay}
            </button>
            <button
              class="svg-icon"
              class:hidden="{myEmbedding
                ? !myEmbedding.playingTimeSlider
                : true}"
            >
              {@html iconPause}
            </button>
          </div>

          <div class="slider-container">
            <div class="back-slider"></div>

            <div class="slider">
              <div class="range-track"></div>
              <div
                class="middle-thumb"
                id="time-slider-middle-thumb"
                tabindex="-1"
              >
                <div class="thumb-label thumb-label-middle">
                  <span class="thumb-label-span"></span>
                </div>
              </div>
            </div>

            <div class="slider-svg-container">
              <svg class="slider-svg"> </svg>
            </div>
          </div>
        </div>
      </button>
    </button>
    {#if $currClickedPoint !== null || $currHoveredPoint !== null}
      <div class="item-wrapper researcher-info-button">
        <div
          class="menu label-menu researcher-info-menu"
          class:hidden="{controlDisplayItem !== 'resInfo'}"
        >
          <div class="researcher-info">
            <button
              on:click="{() => {
                controlDisplayItem = '';
                // Clear selections when closing panel
                currClickedPoint.set(null);
                // currHoveredPoint.set(null);
              }}"
            >
              <div class="svg-icon close">
                {@html iconClose}
              </div>
            </button>

            <div class="scholar-info">
              <img
                class="tooltip-res-image"
                src="{currentPoint?.currURL || `${import.meta.env.BASE_URL}default-scholar-profile-picture.png`}"
                on:error="{e => {
                  e.currentTarget.src = `${import.meta.env.BASE_URL}default-scholar-profile-picture.png`;
                }}"
              />

              <h3>
                {currentPoint?.name}
              </h3>
              <p id="res-title">{currentPoint?.currAffiliations}</p>
              <span class="site-info">
                {#if homepage && homepage !== 'Homepage not specified'}
                  <span>
                    <a
                      style="color: hsl(206, 89.74%, 54.12%);"
                      href="{homepage}"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Homepage
                    </a>
                  </span>
                {/if}

                <span>
                  Citations: {currentPoint?.currCitationCount}
                </span>
              </span>

              <span style="font-size: 1.2em; margin-bottom: 10px;">
                <a
                  style="color: hsl(206, 89.74%, 54.12%);"
                  target="_blank"
                  rel="noopener noreferrer"
                  href="{currentPoint?.googleScholarURLs}"
                  >Google Scholar&nbsp;</a
                >
                {#if currentPoint?.googleScholarKeywords && currentPoint.googleScholarKeywords !== 'No Keywords Specified'}
                  keywords:
                {/if}
              </span>
              <div style="text-align: center; font-size: 18px; color: gray;">
                <span>
                  {#if currentPoint?.googleScholarKeywords && currentPoint.googleScholarKeywords !== 'No Keywords Specified'}
                    {currentPoint.googleScholarKeywords}
                  {/if}
                </span>
              </div>
            </div>

            <div id="res-divider-info">
              <hr />
            </div>

            <div class="svg-icon info-panel">
              {@html iconInfo}
              <div class="info-tooltip">
                This researcher summary was produced with the <em
                  >Gemini&nbsp;2.5 Pro</em
                >
                model, using the <u>abstracts</u> and <u>titles</u> of each
                researcher's <strong>50 most-cited papers</strong> plus their
                Google&nbsp;Scholar keywords. This
                <strong>AI generated summary</strong>
                may contain <em>inaccuracies or misinterpretations</em>.
                <u>Please verify any critical information independently.</u>
              </div>
            </div>

            <div class="researcher-info-content">
              <div class="summary-container">
                <p>
                  {@html DOMPurify.sanitize(currentPoint?.currSummary || '')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
