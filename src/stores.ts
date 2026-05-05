import { writable } from 'svelte/store';
import type { PromptPoint } from './types/embedding-types';
import d3 from './utils/d3-import';

export interface SearchBarStoreValue {
  shown: boolean;
  results: PromptPoint[];
  scores?: Array<{
    id: number;
    semanticScore?: number;
    textScore?: number;
    totalScore?: number;
  }>;
  query: string;
  queryID: number;
  highlightSearchPoint: (point: PromptPoint | undefined) => void;
  selectSearchPoint: (point: PromptPoint | undefined, oldPoint?: PromptPoint | null, zoomOut?: boolean) => void;
}

export interface FooterStoreValue {
  numPoints: number;
  curZoomTransform: d3.ZoomTransform;
  initZoomK: number;
  xScale: d3.ScaleLinear<number, number, never>;
  embeddingName: string;
  messageID: number;
  messageCommand: 'zoomIn' | 'zoomOut' | 'zoomReset' | '';
  promptPoints?: PromptPoint[];
}

export interface TooltipStoreValue {
  show: boolean;
  html: string;
  x: number;
  y: number;
  width: number;
  maxWidth: number;
  fontSize: number;
  orientation: string;
  mouseoverTimeout: number | null;
}

// Store for currently hovered point
// export const currHoveredPoint = writable<PromptPoint | null>(null);

// Store for currently clicked/selected point
// export const currClickedPoint = writable<PromptPoint | null>(null);

export const getSearchBarStoreDefaultValue = (): SearchBarStoreValue => {
  return {
    shown: false,
    results: [],
    scores: [],
    query: '',
    queryID: 0,
    highlightSearchPoint: () => { },
    selectSearchPoint: () => { }
  };
};

export const getFooterStoreDefaultValue = (): FooterStoreValue => {
  return {
    numPoints: 0,
    curZoomTransform: d3.zoomIdentity,
    initZoomK: 1,
    xScale: d3.scaleLinear(),
    embeddingName: 'Embedding',
    messageID: 0,
    messageCommand: '',
    promptPoints: []

  };
};

export const getTooltipStoreDefaultValue = (): TooltipStoreValue => {
  return {
    show: false,
    html: 'null',
    x: 0,
    y: 0,
    width: 0,
    maxWidth: 300,
    fontSize: 14,
    orientation: 's',
    mouseoverTimeout: null
  };
};

export const getSearchBarStore = () => {
  return writable(getSearchBarStoreDefaultValue());
};

export const getFooterStore = () => {
  return writable(getFooterStoreDefaultValue());
};

export const getTooltipStore = () => {
  return writable(getTooltipStoreDefaultValue());
};
