<script lang="ts">
  import { onMount } from 'svelte';
  import type { Writable } from 'svelte/store';
  import logoUrl from '/logo.ico?url';
  import type { FooterStoreValue } from '../../stores';
  import { Footer } from './Footer';
  import { UNIVERSITY_NAME, DEPARTMENT_NAME } from '../../config/theme';

  const footerLabel = DEPARTMENT_NAME
    ? `${UNIVERSITY_NAME} — ${DEPARTMENT_NAME}`
    : UNIVERSITY_NAME;

  export let footerStore: Writable<FooterStoreValue>;

  let component: HTMLElement | null = null;
  let dialogElement: HTMLDialogElement | null = null;
  let mounted = false;
  let initialized = false;
  let myFooter: Footer | null = null;
  const scaleWidth = 50;

  let dataURLInput = '';
  let gridURLInput = '';

  const footerUpdated = () => {
    myFooter = myFooter;
  };

  const datasetClicked = () => {
    if (dialogElement === null) return;
    // Show modal
    try {
      dialogElement.showModal();
    } catch (e) {
      console.error(e);
    }
  };

  const useMyEmbeddingClicked = () => {
    // Encode the urls as query string
    if (dataURLInput !== '' && gridURLInput !== '') {
      const dataURL = encodeURIComponent(dataURLInput);
      const gridURL = encodeURIComponent(gridURLInput);
      const targetURL = `./?dataURL=${dataURL}&gridURL=${gridURL}`;
      dialogElement?.close();
      window.location.href = targetURL;
    }
  };

  onMount(() => {
    mounted = true;
    // datasetClicked();
  });

  /**
   * Initialize the embedding view.
   */
  // $: console.log(scaleWidth);
  const initView = () => {
    initialized = true;

    if (component && footerStore) {
      myFooter = new Footer(component, scaleWidth, footerStore, footerUpdated);
    }
  };

  $: mounted && !initialized && component && footerStore && initView();
</script>

<style lang="scss">
  @import './Footer.scss';
</style>

<div class="footer-wrapper" bind:this="{component}">
  <dialog id="dataset-dialog" bind:this="{dialogElement}">
    <div class="header">Choose an Embedding</div>

    <div class="row-block">
      <div class="dataset-list">
        <ul>
          <li>
            <a href="./?dataset=diffusiondb"
              >DiffusionDB (1.8M text + 1.8M images)</a
            >
          </li>
          <li>
            <a href="./?dataset=acl-abstracts"> ACL Abstracts (63k text) </a>
          </li>
          <li>
            <a href="./?dataset=imdb"> IMDB Reviews (25k text) </a>
          </li>
        </ul>
      </div>
    </div>

    <div class="separator"></div>

    <div class="header">My Own Embedding</div>

    <div class="input-form">
      <div class="row">
        <span class="row-header">
          Data JSON URL <a
            href="https://github.com/poloclub/wizmap#use-my-own-embeddings"
            target="_blank">(what is this?)</a
          >
        </span>
        <input placeholder="https://xxx.ndjson" bind:value="{dataURLInput}" />
      </div>

      <div class="row">
        <span class="row-header">
          Grid JSON URL <a
            href="https://github.com/poloclub/wizmap#use-my-own-embeddings"
            target="_blank">(what is this?)</a
          >
        </span>
        <input placeholder="https://xxx.json" bind:value="{gridURLInput}" />
      </div>
    </div>

    <div class="button-block">
      <button class="close-button" on:click="{() => useMyEmbeddingClicked()}"
        >Create</button
      >

      <button
        class="close-button"
        on:click="{() => {
          dialogElement?.close();
        }}">Close</button
      >
    </div>
  </dialog>

  <div class="footer">
    <span class="logo-section">
      <img src="{logoUrl}" alt="Logo" class="logo-icon" />
      <span class="text">{footerLabel}</span>
    </span>
    <div class="splitter"></div>

    <!-- <a href="https://arxiv.org/abs/2306.09328"
      ><span class="item">
        <span class="svg-icon">{@html iconFile}</span>
        Paper
      </span></a
    > -->
    <!-- <div class="splitter"></div> -->

    <!-- <a href="https://youtu.be/8fJG87QVceQ"
      ><span class="item">
        <span class="svg-icon">{@html iconPlay}</span>
        Video
      </span></a
    > -->
    <!-- <div class="splitter"></div> -->

    <!-- <button
      on:click="{() => {
        datasetClicked();
      }}"><span class="item"> {myFooter?.embeddingName} </span></button
    >
    <div class="splitter"></div> -->

    <span class="count">
      <span class="total-count" class:hidden="{false}"
        >{myFooter ? myFooter.numPoints : '0'} Researchers <span class="subtitle">(with Google Scholar
        Profiles)</span>
      </span>
      <span class="subset-count" class:hidden="{true}"
        >177 Researchers <span class="subtitle">(with Google Scholar Profiles)</span></span
      >
    </span>
    <div class="splitter"></div>
    <span class="zoom-level">
      Zoom: {myFooter ? myFooter.zoomLevel : '1.0x'}
    </span>
    <div class="splitter"></div>
    <div class="scale-legend">
      <span class="sclae-num"
        >{myFooter ? myFooter.scaleDataWidth : '0.0000'}</span
      >
      <div class="scale-line" style="{`width: ${scaleWidth}px`}"></div>
    </div>
  </div>
</div>
