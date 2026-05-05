import createRegl from 'regl';
import { writable, type Writable } from 'svelte/store';
import { config } from '../../config/config';
import type { FooterStoreValue, SearchBarStoreValue } from '../../stores';
import {
  getFooterStoreDefaultValue,
  getSearchBarStoreDefaultValue
} from '../../stores';
import type { Padding, Point, Rect, Size } from '../../types/common-types';
import type {
  DataURLs,
  Direction,
  DrawnLabel,
  EmbeddingInitSetting,
  GridData,
  LevelTileMap,
  LoaderWorkerMessage,
  PromptPoint,
  SearchWorkerMessage,
  TopicData,
  TreeWorkerMessage,
  WebGLMatrices
} from '../../types/embedding-types';
import d3 from '../../utils/d3-import';
import { PointForceSimulation } from '../../utils/ForceSimulation';
import {
  allTrue,
  anyTrue,
  timeit
} from '../../utils/utils';
import * as Controller from './EmbeddingControl';
import * as Labeler from './EmbeddingLabel';
import { updatePopperTooltip } from './EmbeddingLabel';
import * as PointDrawer from './EmbeddingPointWebGL';
import { currClickedPoint } from './EmbeddingPointWebGL';
import LoaderWorker from './workers/loader?worker&inline';
import SearchWorker from './workers/search?worker&inline';
import TreeWorker from './workers/tree?worker&inline';

const DEBUG = config.debug;
const HOVER_RADIUS = 3;
let handledFooterMessageID = 0;


/**
 * Class for the Embedding view
 */

export class Embedding {
  svg: d3.Selection<HTMLElement, unknown, null, undefined>;
  /** The size of the BBox of the SVG element */
  svgFullSize: Size;
  /** The size of the drawing space of the SVG element */
  svgSize: Size;
  svgPadding: Padding;

  topSvg: d3.Selection<HTMLElement, unknown, null, undefined>;
  topicCanvases: d3.Selection<HTMLElement, unknown, null, undefined>[];

  pointCanvas: d3.Selection<HTMLElement, unknown, null, undefined>;
  pointRegl: createRegl.Regl;
  frontPositionBuffer: createRegl.Buffer | null = null;
  frontTextureCoordinateBuffer: createRegl.Buffer | null = null;
  frontBufferPointSize = 0;

  searchPointCanvas: d3.Selection<HTMLElement, unknown, null, undefined>;
  searchPointRegl: createRegl.Regl;
  searchPointPositionBuffer: createRegl.Buffer | null = null;
  searchPointTextureCoordinateBuffer: createRegl.Buffer | null = null;
  searchPointResults: PromptPoint[] = [];

  // Tooltips
  tooltipTop: HTMLElement;
  tooltipBottom: HTMLElement;
  tooltipClicked: HTMLElement;
  hoverPoint: PromptPoint | null = null;
  clickedPoint: PromptPoint | null = null;
  tooltipShowTimer: number | null = null;

  xScale: d3.ScaleLinear<number, number, never>;
  yScale: d3.ScaleLinear<number, number, never>;
  component: HTMLElement;
  updateEmbedding: () => void;

  // Zooming
  zoom: d3.ZoomBehavior<HTMLElement, unknown> | null = null;
  initZoomTransform = d3.zoomIdentity;
  curZoomTransform: d3.ZoomTransform = d3.zoomIdentity;
  curZoomLevel = 1;

  // Interactions
  lastMouseClientPosition: Point | null = null;
  hideHighlights = false;
  isSelectingFromSearch = false;

  // User settings
  showContours: boolean[];
  showGrid: boolean;
  showPoints: boolean[];
  showLabel: boolean;

  // Data
  dataURLs: DataURLs;
  promptPoints: PromptPoint[] = [];
  gridData: GridData | null = null;
  tileData: LevelTileMap | null = null;
  contours: d3.ContourMultiPolygon[] | null = null;
  groupContours: d3.ContourMultiPolygon[][] | null = null;
  labelSummariesVisible: boolean | null;
  contoursInitialized = false;
  loadedPointCount = 1;

  // Time
  playingTimeSlider = false;
  timeScale: d3.ScaleTime<number, number, never> | null = null;
  timeFormatter: ((x: Date) => string) | null = null;
  curTime: string | null = null;
  timeTextureMap: Map<string, number> | null = null;
  timeCountMap: Map<string, number> | null = null;
  timeInspectMode = false;

  // Group
  groupNames: string[] | null = null;

  // Search
  completedSearchQueryID = 0;

  // Scatter plot
  lastRefillID = 0;
  lastRefillTime = 0;
  webGLMatrices: WebGLMatrices | null = null;
  curPointWidth = 1;

  // Stores
  footerStore: Writable<FooterStoreValue>;
  footerStoreValue: FooterStoreValue;
  searchBarStore: Writable<SearchBarStoreValue>;
  searchBarStoreValue: SearchBarStoreValue;

  // Display labels
  topicLevelTrees: Map<number, d3.Quadtree<TopicData>> = new Map<
    number,
    d3.Quadtree<TopicData>
  >();
  maxLabelNum = 1000;
  curLabelNum = 0;
  userMaxLabelNum = 30; // Initial slider value/default labels shown
  lastLabelNames: Map<string, Direction> = new Map();
  lastLabelTreeLevel: number | null = null;
  lastGridTreeLevels: number[] = [];
  lastDrawnLabels: DrawnLabel[] = [];
  lastLabelLayoutTime = 0;

  // Local quadtree for fast hover detection (O(log n) instead of O(n))
  pointQuadtree: d3.Quadtree<PromptPoint> | null = null;

  // Web workers
  loaderWorker: Worker;
  treeWorker: Worker;
  searchWorker: Worker;

  // Store unsubscribe functions
  private storeUnsubscribers: (() => void)[] = [];

  // Methods implemented in other files
  // Labels
  drawLabels = Labeler.drawLabels;
  layoutTopicLabels = Labeler.layoutTopicLabels;
  addTileIndicatorPath = Labeler.addTileIndicatorPath;
  getIdealTopicTreeLevel = Labeler.getIdealTopicTreeLevel;
  labelNumSliderChanged = Labeler.labelNumSliderChanged;
  mouseoverLabel = Labeler.mouseoverLabel;
  drawTopicGrid = Labeler.drawTopicGrid;
  redrawTopicGrid = Labeler.redrawTopicGrid;
  drawTopicGridFrame = Labeler.drawTopicGridFrame;

  // Method to show labels (now defaults to all grid topics)
  showAllGridLabels() {
    this.layoutTopicLabels(this.userMaxLabelNum, false, true);
  }
  // Points
  initWebGLBuffers = PointDrawer.initWebGLBuffers;
  updateWebGLBuffers = PointDrawer.updateWebGLBuffers;
  drawScatterPlot = PointDrawer.drawScatterPlot;
  initWebGLMatrices = PointDrawer.initWebGLMatrices;
  highlightPoint = PointDrawer.highlightPoint;
  updateHighlightPoint = PointDrawer.updateHighlightPoint;
  drawSearchScatterPlot = PointDrawer.drawSearchScatterPlot;

  // Control
  initTopControlBar = Controller.initTopControlBar;
  timeSliderMouseDownHandler = Controller.timeSliderMouseDownHandler;
  moveTimeSliderThumb = Controller.moveTimeSliderThumb;
  startTimeSliderAnimation = Controller.startTimeSliderAnimation;
  playPauseClickHandler = Controller.playPauseClickHandler;
  drawContourTimeSlice = Controller.drawContourTimeSlice;

  // Add a new property for the force simulation
  forceSimulation: PointForceSimulation | null = null;

  /**
   * Rebuild the local quadtree from current promptPoints for O(log n) hover detection
   */
  rebuildPointQuadtree() {
    this.pointQuadtree = d3.quadtree<PromptPoint>()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(this.promptPoints);
  }

  // Resize handler
  private resizeHandler: (() => void) | null = null;

  private rafPending = false;
  private lastMouseMoveTime = 0;
  private readonly MOUSE_MOVE_THROTTLE = 16; // ~60fps

  private zoomRafPending = false;
  private lastZoomTime = 0;
  private readonly ZOOM_THROTTLE = 16; // ~60fps
  private zoomTimeout: number | null = null;

  // Safari optimization: separate real-time from deferred operations
  private deferredZoomTimeout: number | null = null;
  private readonly DEFERRED_ZOOM_DELAY = 300; // Wait 300ms after zoom stops
  private isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  // Dispersal animation properties
  private animationFrameId: number | null = null;
  private animationStartTime = 0;
  private readonly ANIMATION_DURATION = 1200; // ms
  private preSimPositions: Map<number, {x: number; y: number}> | null = null;
  private postSimPositions: Map<number, {x: number; y: number}> | null = null;
  private isAnimatingDispersal = false;

  /**
   *
   * @param args Named parameters
   * @param args.component The component
   */
  constructor({
    component,
    updateEmbedding,
    defaultSetting,
    dataURLs,
    footerStore,
    searchBarStore
  }: {
    component: HTMLElement;
    updateEmbedding: () => void;
    defaultSetting: EmbeddingInitSetting;
    dataURLs: DataURLs;
    footerStore: Writable<FooterStoreValue>;
    searchBarStore: Writable<SearchBarStoreValue>;
  }) {
    this.component = component;
    this.updateEmbedding = updateEmbedding;
    this.dataURLs = dataURLs;

    this.footerStore = footerStore;
    this.footerStoreValue = getFooterStoreDefaultValue();

    this.searchBarStore = searchBarStore;
    this.searchBarStoreValue = getSearchBarStoreDefaultValue();

    // Init some properties based on the default setting
    this.showContours = [defaultSetting.showContour];
    this.showGrid = defaultSetting.showGrid;
    this.showPoints = [defaultSetting.showPoint];
    this.showLabel = defaultSetting.showLabel;

    // Initialize the web worker to load data and deal with the quadtree
    this.loaderWorker = new LoaderWorker();
    this.loaderWorker.onmessage = (e: MessageEvent<LoaderWorkerMessage>) => {
      this.loaderWorkerMessageHandler(e);
    };
    this.loaderWorker.onerror = (e) => {
      console.error('LoaderWorker error:', e.message);
    };

    this.treeWorker = new TreeWorker();
    this.treeWorker.onmessage = (e: MessageEvent<TreeWorkerMessage>) => {
      this.treeWorkerMessageHandler(e);
    };
    this.treeWorker.onerror = (e) => {
      console.error('TreeWorker error:', e.message);
    };

    this.searchWorker = new SearchWorker();
    this.searchWorker.onmessage = (e: MessageEvent<SearchWorkerMessage>) => {
      this.searchWorkerMessageHandler(e);
    };
    this.searchWorker.onerror = (e) => {
      console.error('SearchWorker error:', e.message);
    };

    // Trigger model loading in this worker instance
    const loadModelMessage: SearchWorkerMessage = {
      command: 'checkModelStatus',
      payload: {
        isLoaded: false
      }
    };
    this.searchWorker.postMessage(loadModelMessage);

    // Initialize the SVG
    this.svg = d3.select(this.component).select('.embedding-svg');

    this.svgFullSize = { width: 0, height: 0 };
    const svgBBox = this.svg.node()?.getBoundingClientRect();
    if (svgBBox !== undefined) {
      this.svgFullSize.width = svgBBox.width;
      this.svgFullSize.height = svgBBox.height;
    }

    // Fix the svg width and height
    this.svg
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);

    this.svgPadding = {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0
    };

    // We keep the initial drawing region as a square
    const squareCanvasWidth = Math.min(
      this.svgFullSize.width - this.svgPadding.left - this.svgPadding.right,
      this.svgFullSize.height - this.svgPadding.top - this.svgPadding.bottom
    );

    this.svgSize = {
      width: squareCanvasWidth,
      height: squareCanvasWidth
    };

    this.xScale = d3.scaleLinear();
    this.yScale = d3.scaleLinear();

    // Initialize the SVG groups
    this.initSVGGroups();

    // Initialize the top svg element
    this.topSvg = this.initTopSvg();

    // Initialize the canvases
    this.pointCanvas = d3
      .select(this.component)
      .select<HTMLElement>('.embedding-canvas')
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);
    this.pointRegl = createRegl(this.pointCanvas!.node() as HTMLCanvasElement);

    // Fade the canvas if the default is to show labels
    this.pointCanvas.classed(
      'faded',
      anyTrue(this.showPoints) && this.showLabel
    );

    this.searchPointCanvas = d3
      .select(this.component)
      .select<HTMLElement>('.search-point-canvas')
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);
    this.searchPointRegl = createRegl(
      this.searchPointCanvas!.node() as HTMLCanvasElement
    );

    this.topicCanvases = [];
    for (const pos of ['top', 'bottom']) {
      this.topicCanvases.push(
        d3
          .select(this.component)
          .select<HTMLElement>(`.topic-grid-canvas.${pos}`)
          .attr('width', `${this.svgFullSize.width}px`)
          .attr('height', `${this.svgFullSize.height}px`)
          .classed('hidden', !this.showGrid)
      );
    }

    // Register zoom
    this.zoom = d3
      .zoom<HTMLElement, unknown>()
      .extent([
        [0, 0],
        [this.svgSize.width, this.svgSize.height]
      ])
      .scaleExtent([config.layout.zoomScale[0], config.layout.zoomScale[1]])
      .interpolate(d3.interpolate)
      .on('zoom', (g: d3.D3ZoomEvent<HTMLElement, unknown>) => {
        (async () => {
          await this.zoomed(g);
        })();
      })
      .on('end', () => this.zoomEnded());

    this.topSvg.call(this.zoom).on('dblclick.zoom', null);

    this.tooltipTop = document.querySelector('#popper-tooltip-top')!;
    this.tooltipBottom = document.querySelector('#popper-tooltip-bottom')!;
    this.tooltipClicked = document.querySelector('#popper-tooltip-clicked')!;

    // Initialize the data
    timeit('Init data', DEBUG);
    this.initData().then(() => {
      timeit('Init data', DEBUG);
      // Initialize the event handler for the top control bars
      this.initTopControlBar();
    });

    this.initStore();
    this.labelSummariesVisible = false;

    // Register resize handler to update dimensions when the window size changes
    this.resizeHandler = () => {
      this.updateDimensions();
    };

    window.addEventListener('resize', this.resizeHandler);
  }

  /**
   * Clean up event listeners and resources
   */
  cleanup = () => {
    // Remove resize event listener
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }

    // Clean up zoom timeouts
    if (this.zoomTimeout !== null) {
      window.clearTimeout(this.zoomTimeout);
      this.zoomTimeout = null;
    }

    if (this.deferredZoomTimeout !== null) {
      window.clearTimeout(this.deferredZoomTimeout);
      this.deferredZoomTimeout = null;
    }

    // Cancel dispersal animation
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Clean up tooltip timer
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }

    // Unsubscribe from stores
    for (const unsub of this.storeUnsubscribers) {
      unsub();
    }
    this.storeUnsubscribers = [];

    // Clean up placeholder rotation interval
    stopPlaceholderRotation();
  };

  /**
   * Update dimensions when window is resized
   */
  updateDimensions = () => {
    // Update SVG size based on new container dimensions
    const svgBBox = this.svg.node()?.getBoundingClientRect();
    if (svgBBox === undefined) return;

    // Store previous dimensions for comparison
    const prevWidth = this.svgFullSize.width;
    const prevHeight = this.svgFullSize.height;

    // Update dimensions
    this.svgFullSize.width = svgBBox.width;
    this.svgFullSize.height = svgBBox.height;

    // Only proceed if dimensions actually changed
    if (prevWidth === this.svgFullSize.width && prevHeight === this.svgFullSize.height) {
      return;
    }


    // Update SVG dimensions
    this.svg
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);

    // Update canvases
    this.pointCanvas
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);

    this.searchPointCanvas
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);

    // Update regl viewports to match new canvas dimensions
    this.pointRegl.poll();
    this.searchPointRegl.poll();

    for (const canvas of this.topicCanvases) {
      canvas
        .attr('width', `${this.svgFullSize.width}px`)
        .attr('height', `${this.svgFullSize.height}px`);
    }

    this.topSvg
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`);

    // Update mouse tracking rect
    this.topSvg.select('g.top-group rect.mouse-track-rect')
      .attr('width', this.svgFullSize.width)
      .attr('height', this.svgFullSize.height);

    // Update WebGL matrices
    if (this.webGLMatrices) {
      this.initWebGLMatrices();
    }

    // Redraw visualization
    this.drawScatterPlot();

    // Redraw search scatter plot if search results are visible
    if (!this.searchPointCanvas.classed('hidden') && this.searchPointResults.length > 0) {
      this.drawSearchScatterPlot();
    }

    // Update other elements as needed
    if (this.showLabel) {
      this.layoutTopicLabels(this.userMaxLabelNum, false);
    }

    if (this.showGrid) {
      this.redrawTopicGrid();
    }

    // Force a redraw
    this.updateEmbedding();
  };

  /**
   * Initialize the top SVG element
   * @returns Top SVG selection
   */
  initTopSvg = () => {
    const topSvg = d3
      .select(this.component)
      .select<HTMLElement>('.top-svg')
      .attr('width', `${this.svgFullSize.width}px`)
      .attr('height', `${this.svgFullSize.height}px`)
      .on('pointermove', e => this.mousemoveHandler(e as MouseEvent))
      .on('click', e => this.clickHandler(e as MouseEvent))
      .on('mouseleave', () => {
        this.highlightPoint({ point: undefined, animated: false });
        this.mouseoverLabel(null, null);
      })
      .attr(
        'transform',
        `translate(${this.svgPadding.left}, ${this.svgPadding.top})`
      );

    const topGroup = topSvg.append('g').attr('class', 'top-group');

    topGroup
      .append('rect')
      .attr('class', 'mouse-track-rect')
      .attr('width', this.svgFullSize.width)
      .attr('height', this.svgFullSize.height);

    const topContent = topGroup.append('g').attr('class', 'top-content');

    topContent.append('g').attr('class', 'topics-bottom');
    topContent
      .append('g')
      .attr('class', 'topics')
      .classed('hidden', !this.showLabel);
    topContent.append('g').attr('class', 'topics-top');
    topContent.append('g').attr('class', 'highlights');
    return topSvg;
  };

  initStore = () => {
    const unsubFooter = this.footerStore.subscribe(value => {
      this.footerStoreValue = value;

      // Handle message requests from the footer zoom buttons
      if (this.footerStoreValue.messageID !== handledFooterMessageID) {
        handledFooterMessageID = this.footerStoreValue.messageID;

        const zoomBox = this.getCurViewingZoomBox();
        const centerX = zoomBox.x + zoomBox.width / 2;
        const centerY = zoomBox.y + zoomBox.height / 2;

        switch (this.footerStoreValue.messageCommand) {
          case 'zoomIn': {
            // Create a zoomIn transform matrix
            const transform = d3.zoomIdentity
              .translate(
                (this.svgFullSize.width + config.layout.searchPanelWidth) / 2,
                (this.svgFullSize.height + config.layout.topBarHeight) / 2
              )
              .scale(
                Math.min(
                  config.layout.zoomScale[1],
                  this.curZoomTransform.k * 2
                )
              )
              .translate(-centerX, -centerY);

            this.hideHighlights = true;
            this.topSvg
              .transition()
              .duration(300)
              .call(selection => this.zoom?.transform(selection, transform))
              .on('end', () => {
                this.hideHighlights = false;
              });

            break;
          }

          case 'zoomOut': {
            // Create a zoomIn transform matrix
            const transform = d3.zoomIdentity
              .translate(
                (this.svgFullSize.width + config.layout.searchPanelWidth) / 2,
                (this.svgFullSize.height + config.layout.topBarHeight) / 2
              )
              .scale(
                Math.max(
                  config.layout.zoomScale[0],
                  this.curZoomTransform.k * 0.5
                )
              )
              .translate(-centerX, -centerY);

            this.hideHighlights = true;
            this.topSvg
              .transition()
              .duration(300)
              .call(selection => this.zoom?.transform(selection, transform))
              .on('end', () => {
                this.hideHighlights = false;
              });

            break;
          }

          case 'zoomReset': {
            this.hideHighlights = true;
            this.topSvg
              .transition()
              .duration(700)
              .call(selection => {
                this.zoom?.transform(selection, this.initZoomTransform);
              })
              .on('end', () => {
                this.hideHighlights = false;
              });
            break;
          }

          case '': {
            break;
          }

          default: {
            console.error(
              'Unknown message',
              this.footerStoreValue.messageCommand
            );
            break;
          }
        }
      }
    });
    this.storeUnsubscribers.push(unsubFooter);

    const unsubSearch = this.searchBarStore.subscribe(value => {
      this.searchBarStoreValue = value;

      // Check if we need to query new results
      if (this.searchBarStoreValue.queryID !== this.completedSearchQueryID) {
        // Search new query
        this.completedSearchQueryID = this.searchBarStoreValue.queryID;
        const message: SearchWorkerMessage = {
          command: 'startQuery',
          payload: {
            query: this.searchBarStoreValue.query,
            queryID: this.searchBarStoreValue.queryID
          }
        };
        this.searchWorker.postMessage(message);
      }

      // Hide the search scatter plot
      if (!this.searchBarStoreValue.shown) {
        this.searchPointCanvas.classed('hidden', true);
        this.searchPointResults = [];
      }

      this.searchBarStoreValue.selectSearchPoint = (point, oldPoint, zoomOut) => {
        if (point) {
          if (this.clickedPoint && this.clickedPoint.id === point.id) {
            this.selectPoint(null);
          } else {
            // Search results always zoom - use smart zoom if switching between points
            if (oldPoint && oldPoint.id !== point.id) {
              this.selectPointWithSmartZoom(point, oldPoint);
            } else {
              // First selection or no old point - use regular zoom
              this.selectPoint(point);
              this.zoomToPoint(point);
            }
          }
        } else {
          // Deselecting - clear selection and optionally zoom out
          this.selectPoint(null);
          if (zoomOut) {
            this.zoomToFullView();
          }
        }
      };
    });
    this.storeUnsubscribers.push(unsubSearch);

    // Subscribe to currClickedPoint changes (e.g., when X button is clicked)
    const unsubClicked = currClickedPoint.subscribe(point => {
      if (point === null) {
        // Point was deselected (e.g., X button clicked)
        this.selectPoint(null);
      }
    });
    this.storeUnsubscribers.push(unsubClicked);
  };

  /**
   * Event handler for click events
   */
  clickHandler = (e: MouseEvent) => {
    // Get click coordinates
    const x = e.offsetX;
    const y = e.offsetY;
    this.lastMouseClientPosition = { x, y };

    // If we're hovering over a point, use that for the click
    if (this.hoverPoint) {
      // Check if we're clicking the same point to toggle it off
      if (this.clickedPoint && this.clickedPoint.id === this.hoverPoint.id) {
        // Clear selection
        this.selectPoint(null);
      } else {
        // Select a new point
        this.selectPoint(this.hoverPoint);
      }
    }
  }

  /**
   * Select or deselect a point
   */
  selectPoint = (point: PromptPoint | null) => {
    // Don't reselect the same point
    if (point === this.clickedPoint) return;

    // Update the clicked point reference
    this.clickedPoint = point;

    // Update the store
    if (this.clickedPoint == undefined) {
      currClickedPoint.set(null);
    } else {
      currClickedPoint.set(point);
    }

    // Handle the visual highlight
    const pointElements = this.topSvg.selectAll('g.point');

    // Reset clicked class on all points
    pointElements.classed('point-clicked', false);
    pointElements.select('circle.point-border').classed('clicked', false);
    pointElements.select('image.image-view').classed('clicked', false);

    if (point) {
      // Find and highlight the clicked point
      const clickedElement = this.topSvg
        .selectAll('g.point')
        .filter((d: any) => d.id === point.id);

      // Add clicked classes to the point and its children
      clickedElement.classed('point-clicked', true);
      clickedElement.select('circle.point-border').classed('clicked', true);
      clickedElement.select('image.image-view').classed('clicked', true);

      // Show tooltip for clicked point
      const clickedNode = clickedElement.node();
      if (clickedNode) {
        const tooltipContent = `<div style="color: black;">${point.name}</div>`;

        this.tooltipClicked.classList.remove('hidden');
        updatePopperTooltip(
          this.tooltipClicked,
          clickedNode as HTMLElement,
          tooltipContent,
          'top'
        );
      }
    } else {
      // Hide clicked tooltip when no point is selected
      this.tooltipClicked.classList.add('hidden');
    }

    // Update the embedding
    this.updateEmbedding();

    // No zoom for direct point clicks - just selection
    // Only search results will trigger zoom via selectPointWithSmartZoom
  };

  /**
   * Select a point and use smart zoom transition
   * @param newPoint The point to select
   * @param oldPoint The previously selected point
   */
  selectPointWithSmartZoom = (newPoint: PromptPoint, oldPoint: PromptPoint) => {
    // Flag to prevent regular zoom in selectPoint
    this.isSelectingFromSearch = true;

    // Use the regular selectPoint method for state management
    this.selectPoint(newPoint);

    // Apply smart zoom transition
    this.smartZoomToPoint(newPoint, oldPoint);

    // Reset the flag
    this.isSelectingFromSearch = false;
  };

  /**
   * Zoom to center a specific point with smooth animation
   * @param point The point to zoom to
   * @param zoomLevel Optional zoom level (defaults to 4x current zoom)
   */
  zoomToPoint = (point: PromptPoint, zoomLevel?: number) => {
    if (!this.zoom || !point) return;

    // Calculate target zoom level
    const targetZoomLevel = zoomLevel || Math.min(
      config.layout.zoomScale[1], // Max zoom level
      Math.max(this.curZoomTransform.k * 4, 4) // 4x current zoom, minimum of 4
    );

    // Get the point's screen coordinates
    const pointX = this.xScale(point.x);
    const pointY = this.yScale(point.y);

    // Calculate the center of the visible viewport (excluding the search panel overlay)
    const viewCenterX = config.layout.searchPanelWidth + (this.svgFullSize.width - config.layout.searchPanelWidth) / 2;
    const viewCenterY = config.layout.topBarHeight + (this.svgFullSize.height - config.layout.topBarHeight) / 2;

    // Create the zoom transform that centers the point
    const transform = d3.zoomIdentity
      .translate(viewCenterX, viewCenterY)
      .scale(targetZoomLevel)
      .translate(-pointX, -pointY);

    // Apply the smooth zoom transition
    this.hideHighlights = true;
    this.topSvg
      .transition()
      .duration(800)
      .ease(d3.easeCubicInOut)
      .call(selection => this.zoom?.transform(selection, transform))
      .on('end', () => {
        this.hideHighlights = false;
      });
  };

  /**
   * Zoom out to show the full map view
   */
  zoomToFullView = () => {
    if (!this.zoom) return;

    // Reset to initial zoom transform (full view)
    this.hideHighlights = true;
    this.topSvg
      .transition()
      .duration(1000)
      .ease(d3.easeCubicInOut)
      .call(selection => this.zoom?.transform(selection, this.initZoomTransform))
      .on('end', () => {
        this.hideHighlights = false;
      });
  };

  /**
   * Smart zoom transition between two points based on their distance
   * @param newPoint The point to zoom to
   * @param oldPoint The currently selected point (optional)
   * @param targetZoomLevel Optional zoom level for final zoom
   */
  smartZoomToPoint = (newPoint: PromptPoint, oldPoint?: PromptPoint | null, targetZoomLevel?: number) => {
    if (!this.zoom || !newPoint) return;

    // If no old point, use regular zoom
    if (!oldPoint) {
      this.zoomToPoint(newPoint, targetZoomLevel);
      return;
    }

    // Calculate distance between points in data coordinates
    const dx = newPoint.x - oldPoint.x;
    const dy = newPoint.y - oldPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Get current viewport dimensions in data coordinates
    const viewRanges = this.getCurViewRanges();
    const viewWidth = Math.abs(viewRanges[1] - viewRanges[0]);
    const viewHeight = Math.abs(viewRanges[3] - viewRanges[2]);
    const maxViewDimension = Math.max(viewWidth, viewHeight);

    // Define distance thresholds based on current viewport
    const closeThreshold = maxViewDimension * 0.25;    // Quarter of viewport
    const mediumThreshold = maxViewDimension * 0.5;    // Half of viewport

    const finalZoomLevel = targetZoomLevel || Math.min(
      config.layout.zoomScale[1],
      Math.max(this.curZoomTransform.k * 4, 4)
    );

    this.hideHighlights = true;

    if (distance < closeThreshold) {
      // Close points: smooth pan without zoom out
      this.smoothPanToPoint(newPoint, finalZoomLevel, 800);
    } else if (distance < mediumThreshold) {
      // Medium distance: small zoom out then zoom to new point
      this.zoomOutThenZoomToPoint(newPoint, 0.8, finalZoomLevel, 800, 1200);
    } else {
      // Far points: significant zoom out then zoom to new point
      this.zoomOutThenZoomToPoint(newPoint, 0.5, finalZoomLevel, 900, 1400);
    }
  };

  /**
   * Smooth pan to a point while maintaining current zoom level
   */
  private smoothPanToPoint = (point: PromptPoint, zoomLevel: number, duration: number) => {
    const pointX = this.xScale(point.x);
    const pointY = this.yScale(point.y);
    const viewCenterX = config.layout.searchPanelWidth + (this.svgFullSize.width - config.layout.searchPanelWidth) / 2;
    const viewCenterY = config.layout.topBarHeight + (this.svgFullSize.height - config.layout.topBarHeight) / 2;

    const transform = d3.zoomIdentity
      .translate(viewCenterX, viewCenterY)
      .scale(zoomLevel)
      .translate(-pointX, -pointY);

    this.topSvg
      .transition()
      .duration(duration)
      .ease(d3.easeCubicInOut)
      .call(selection => this.zoom?.transform(selection, transform))
      .on('end', () => {
        this.hideHighlights = false;
      });
  };

  /**
   * Zoom out first, then zoom to new point
   */
  private zoomOutThenZoomToPoint = (
    point: PromptPoint,
    intermediateZoom: number,
    finalZoom: number,
    zoomOutDuration: number,
    zoomInDuration: number
  ) => {
    // Get center point between current view and target point
    const currentCenter = this.getCurrentViewCenter();
    const targetPointX = this.xScale(point.x);
    const targetPointY = this.yScale(point.y);

    const intermediateX = (currentCenter.x + targetPointX) / 2;
    const intermediateY = (currentCenter.y + targetPointY) / 2;

    const viewCenterX = config.layout.searchPanelWidth + (this.svgFullSize.width - config.layout.searchPanelWidth) / 2;
    const viewCenterY = config.layout.topBarHeight + (this.svgFullSize.height - config.layout.topBarHeight) / 2;

    // First transition: zoom out to intermediate point
    const intermediateTransform = d3.zoomIdentity
      .translate(viewCenterX, viewCenterY)
      .scale(this.curZoomTransform.k * intermediateZoom)
      .translate(-intermediateX, -intermediateY);

    this.topSvg
      .transition()
      .duration(zoomOutDuration)
      .ease(d3.easeQuadInOut)
      .call(selection => this.zoom?.transform(selection, intermediateTransform))
      .on('end', () => {
        // Second transition: zoom into target point
        const finalTransform = d3.zoomIdentity
          .translate(viewCenterX, viewCenterY)
          .scale(finalZoom)
          .translate(-targetPointX, -targetPointY);

        this.topSvg
          .transition()
          .duration(zoomInDuration)
          .ease(d3.easeQuadInOut)
          .call(selection => this.zoom?.transform(selection, finalTransform))
          .on('end', () => {
            this.hideHighlights = false;
          });
      });
  };

  /**
   * Get the current center of the view in screen coordinates
   */
  private getCurrentViewCenter = (): Point => {
    const viewCenterX = config.layout.searchPanelWidth + (this.svgFullSize.width - config.layout.searchPanelWidth) / 2;
    const viewCenterY = config.layout.topBarHeight + (this.svgFullSize.height - config.layout.topBarHeight) / 2;

    // Convert back to data coordinates to get the actual center point
    const dataCenterX = this.curZoomTransform.invertX(viewCenterX);
    const dataCenterY = this.curZoomTransform.invertY(viewCenterY);

    return { x: dataCenterX, y: dataCenterY };
  };

  /**
   * Update the selected point highlight during zoom
   */
  updateSelectedPointHighlight = () => {
    if (!this.clickedPoint) return;

    const group = this.topSvg.select('g.top-content g.highlights');
    const selectedPointHighlight = group.select('circle.selected-point');

    if (selectedPointHighlight.empty()) return;

    // Use the EXACT same scaling logic as in highlightPoint function
    const highlightRadius = Math.max(
      12 / this.curZoomTransform.k,
      (this.curPointWidth * Math.exp(Math.log(this.curZoomTransform.k) * 0.55)) /
      this.curZoomTransform.k
    );
    const highlightStroke = (this.curPointWidth * 0.3) / this.curZoomTransform.k;

    // Update the highlight
    selectedPointHighlight
      .attr('cx', this.xScale(this.clickedPoint.x))
      .attr('cy', this.yScale(this.clickedPoint.y))
      .attr('r', highlightRadius)
      .style('fill', 'black')
      .style('fill-opacity', 1)
      .style('stroke', 'white')
      .style('stroke-width', highlightStroke);
  }


  /**
   * Load the UMAP data from json.
   */
  initData = async () => {
    // Read the grid data for contour background
    // Await the data to load to get the range for x and y
    const gridData = await d3.json<GridData>(this.dataURLs.grid);

    if (gridData === undefined) {
      console.error('initData: Failed to load grid data.');
      return;
    }
    this.gridData = gridData;

    // Initialize the data scales
    const xRange = this.gridData.xRange;
    const yRange = this.gridData.yRange;

    // Force the plot to be a square
    let xLength = xRange[1] - xRange[0];
    let yLength = yRange[1] - yRange[0];

    if (!this.gridData.padded) {
      // Add padding for the data
      if (xLength < yLength) {
        yRange[0] -= yLength / 50;
        yRange[1] += yLength / 50;
        yLength = yRange[1] - yRange[0];

        xRange[0] -= (yLength - xLength) / 2;
        xRange[1] += (yLength - xLength) / 2;
      } else {
        // Add padding for the data
        xRange[0] -= xLength / 50;
        xRange[1] += xLength / 50;
        xLength = xRange[1] - xRange[0];

        yRange[0] -= (xLength - yLength) / 2;
        yRange[1] += (xLength - yLength) / 2;
      }
    }

    this.xScale = d3
      .scaleLinear()
      .domain(xRange)
      .range([0, this.svgSize.width]);

    this.yScale = d3
      .scaleLinear()
      .domain(yRange)
      .range([this.svgSize.height, 0]);

    this.contours = this.drawContour();

    // Create time scale if the data has time info
    if (this.gridData.timeGrids) {
      const dates: Date[] = [];
      this.timeTextureMap = new Map<string, number>();
      this.timeCountMap = new Map<string, number>();

      let curI = 0;

      for (const key of Object.keys(this.gridData.timeGrids)) {
        let curDate = new Date(key);
        // If the user doesn't specify a time zone, treat the date in UTC
        if (!key.includes('T')) {
          curDate = new Date(key + 'T00:00:00.000Z');
        }
        dates.push(curDate);

        // Create a map to map time string to texture coordinate
        this.timeTextureMap.set(key, curI);
        curI += 1;

        // Initialize the time counter
        this.timeCountMap.set(key, this.gridData.timeCounter![key]);
      }

      // Add an extra key for rows with invalid time
      this.timeTextureMap.set('bad', curI);

      const minDate = d3.min(dates)!;
      const maxDate = d3.max(dates)!;

      this.timeFormatter = d3.utcFormat(this.gridData.timeFormat!);
      this.timeScale = d3
        .scaleUtc()
        .domain([minDate, maxDate])
        .range([0, config.layout.timeSliderWidth]);
      this.curTime = this.timeFormatter(minDate);
    }

    // Create group related structures if the data has groups
    if (this.gridData.groupGrids && this.gridData.groupNames) {
      this.groupNames = this.gridData.groupNames;
      const umapGroup = this.svg.select('g.umap-group');

      // Adjust the first contour's name
      this.showContours = [];
      this.showPoints = [];
      this.groupContours = [];

      for (let i = 0; i < this.groupNames.length; i++) {
        // Add groups to the control states
        // (Default is to show the first group only)
        this.showContours.push(i === 0);
        this.showPoints.push(i === 0);

        // Add contour elements for other groups
        const name = this.groupNames[i];
        umapGroup
          .append('g')
          .attr('class', `contour-group-generic contour-group-${name}`)
          .classed('hidden', i !== 0);

        // Drw the group contour
        const curContour = this.drawGroupContour(name);
        if (curContour !== null) {
          this.groupContours.push(curContour);
        }
      }
    }

    // Tell the tree worker to prepare to add points to the tree
    const groupIDs = [];

    if (this.groupNames) {
      for (let i = 0; i < this.groupNames.length; i++) {
        groupIDs.push(i);
      }
    }
    const treeMessage: TreeWorkerMessage = {
      command: 'initQuadtree',
      payload: {
        xRange,
        yRange,
        groupIDs: groupIDs,
        times: this.timeCountMap ? [...this.timeCountMap.keys()] : []
      }
    };
    this.treeWorker.postMessage(treeMessage);

    // Handling the topic label data
    // Create a quad tree at each level
    for (const level of Object.keys(this.gridData.topic.data)) {
      const tree = d3
        .quadtree<TopicData>()
        .x(d => d[0])
        .y(d => d[1])
        .addAll(this.gridData.topic.data[level]);
      this.topicLevelTrees.set(parseInt(level), tree);
    }

    // Show topic labels once we have contours and topic data
    this.drawTopicGrid();
    this.layoutTopicLabels(this.userMaxLabelNum, false);

    // Initialize the slider value
    setTimeout(() => {
      (
        this.component.querySelector(
          'input#slider-label-num'
        ) as HTMLInputElement
      ).value = `${this.curLabelNum}`;
    }, 500);

    // Initialize WebGL matrices once we have the scales
    this.initWebGLMatrices();

    // Send the xScale to the footer
    this.footerStoreValue.xScale = this.xScale;
    this.footerStoreValue.embeddingName = this.gridData.embeddingName;
    this.footerStore.set(this.footerStoreValue);

    // Send the highlight update function to the search panel
    const highlightSearchPoint = (point: PromptPoint | undefined) => {
      this.highlightPoint({ point, animated: true });
    };
    this.searchBarStoreValue.highlightSearchPoint = highlightSearchPoint;
    this.searchBarStore.set(this.searchBarStoreValue);

    this.updateEmbedding();
  };

  /**
   * Initialize the groups to draw elements in the SVG.
   */
  initSVGGroups = () => {
    const umapGroup = this.svg
      .append('g')
      .attr('class', 'umap-group')
      .attr(
        'transform',
        `translate(${this.svgPadding.left}, ${this.svgPadding.top})`
      );

    umapGroup
      .append('g')
      .attr('class', 'contour-group')
      .classed('hidden', !this.showContours[0]);

    umapGroup
      .append('g')
      .attr('class', 'contour-group-time')
      .classed('hidden', !this.timeInspectMode);
  };

  /**
   * Draw the KDE contour in the background.
   */
  drawContour = () => {
    if (this.gridData == null) {
      console.error('Grid data not initialized');
      return null;
    }

    const contourGroup = this.svg
      .select<SVGGElement>('.contour-group')
      // Hide the total contour if the user specifies groups
      .style(
        'display',
        this.gridData.groupGrids !== undefined &&
          this.gridData.groupNames !== undefined
          ? 'none'
          : 'unset'
      );

    const gridData1D: number[] = [];
    for (const row of this.gridData.grid) {
      for (const item of row) {
        gridData1D.push(item);
      }
    }

    // Linear interpolate the levels to determine the thresholds
    const levels = config.layout.contourLevels;
    const thresholds: number[] = [];
    const minValue = Math.min(...gridData1D);
    const maxValue = Math.max(...gridData1D);
    const step = (maxValue - minValue) / levels;
    for (let i = 0; i < levels; i++) {
      thresholds.push(minValue + step * i);
    }

    let contours = d3
      .contours()
      .thresholds(thresholds)
      .size([this.gridData.grid.length, this.gridData.grid[0].length])(
        gridData1D
      );

    // Convert the scale of the generated paths
    const contourXScale = d3
      .scaleLinear()
      .domain([0, this.gridData.grid.length])
      .range(this.gridData.xRange);

    const contourYScale = d3
      .scaleLinear()
      .domain([0, this.gridData.grid[0].length])
      .range(this.gridData.yRange);

    contours = contours.map(item => {
      item.coordinates = item.coordinates.map(coordinates => {
        return coordinates.map(positions => {
          return positions.map(point => {
            return [
              this.xScale(contourXScale(point[0])),
              this.yScale(contourYScale(point[1]))
            ];
          });
        });
      });
      return item;
    });

    // Create a new blue interpolator based on d3.interpolateBlues
    // (starting from white here)
    const blueScale = d3.interpolateLab(
      '#ffffff',
      config.layout['groupColors'][0]
    );
    const colorScale = d3.scaleSequential(
      d3.extent(thresholds) as number[],
      d => blueScale(d / 1)
    );

    // Draw the contours
    contourGroup
      .selectAll('path')
      .data(contours.slice(1))
      .join('path')
      .attr('fill', d => colorScale(d.value))
      .attr('d', d3.geoPath());

    // Zoom in to focus on the second level of the contour
    // The first level is at 0
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;

    if (contours.length > 1) {
      for (const coord of contours[1].coordinates) {
        for (const coordPoints of coord) {
          for (const point of coordPoints) {
            if (point[0] < x0) x0 = point[0];
            if (point[1] < y0) y0 = point[1];
            if (point[0] > x1) x1 = point[0];
            if (point[1] > y1) y1 = point[1];
          }
        }
      }
    }

    const screenPadding = 20;
    const viewAreaWidth =
      this.svgFullSize.width - config.layout.searchPanelWidth;
    const viewAreaHeight =
      this.svgFullSize.height -
      config.layout.topBarHeight -
      config.layout.footerHeight;

    const initZoomK = Math.min(
      viewAreaWidth / (x1 - x0 + screenPadding),
      viewAreaHeight / (y1 - y0 + screenPadding)
    );

    let offsetX = 0.10 * this.svgFullSize.width;
    console.log(offsetX, this.svgFullSize.width)
    this.initZoomTransform = d3.zoomIdentity
      .translate(
        (this.svgFullSize.width + config.layout.searchPanelWidth) / 2,
        (this.svgFullSize.height + config.layout.topBarHeight) / 2
      )
      .scale(initZoomK)
      .translate(-(x0 + (x1 - x0) / 2) - offsetX, -(y0 + (y1 - y0) / 2));

    // Store the initial zoom scale for relative zoom calculation
    this.footerStoreValue.initZoomK = initZoomK;
    this.footerStore.set(this.footerStoreValue);

    // Trigger the first zoom
    this.topSvg
      .call(selection =>
        this.zoom?.transform(selection, this.initZoomTransform)
      )
      .on('end', () => {
        this.contoursInitialized = true;
      });

    // Double click to reset zoom to the initial viewpoint
    this.topSvg.on('dblclick', () => {
      this.topSvg
        .transition()
        .duration(700)
        .call(selection => {
          this.zoom?.transform(selection, this.initZoomTransform);
        });
    });

    return contours;
  };

  /**
   * Draw the contour for other groups
   */
  drawGroupContour = (group: string) => {
    if (this.gridData == null || this.gridData.groupGrids === undefined) {
      console.error('Grid data not initialized');
      return null;
    }

    const contourGroup = this.svg.select<SVGGElement>(
      `.contour-group-${group}`
    );

    const gridData1D: number[] = [];
    const grid = this.gridData.groupGrids[group];
    for (const row of grid) {
      for (const item of row) {
        gridData1D.push(item);
      }
    }

    // Linear interpolate the levels to determine the thresholds
    const levels = config.layout.contourLevels;
    const thresholds: number[] = [];
    const minValue = Math.min(...gridData1D);
    const maxValue = Math.max(...gridData1D);
    const step = (maxValue - minValue) / levels;
    for (let i = 0; i < levels; i++) {
      thresholds.push(minValue + step * i);
    }

    let contours = d3
      .contours()
      .thresholds(thresholds)
      .size([grid.length, grid[0].length])(gridData1D);

    // Convert the scale of the generated paths
    const contourXScale = d3
      .scaleLinear()
      .domain([0, grid.length])
      .range(this.gridData.xRange);

    const contourYScale = d3
      .scaleLinear()
      .domain([0, grid[0].length])
      .range(this.gridData.yRange);

    contours = contours.map(item => {
      item.coordinates = item.coordinates.map(coordinates => {
        return coordinates.map(positions => {
          return positions.map(point => {
            return [
              this.xScale(contourXScale(point[0])),
              this.yScale(contourYScale(point[1]))
            ];
          });
        });
      });
      return item;
    });

    // Create a new color interpolator
    // (starting from white here)
    const colorScaleInterpolator = d3.interpolateLab(
      '#ffffff',
      config.layout['groupColors'][this.groupNames?.indexOf(group) || 0]
    );
    const colorScale = d3.scaleSequential(
      d3.extent(thresholds) as number[],
      d => colorScaleInterpolator(d / 1)
    );

    // Draw the contours
    contourGroup
      .selectAll('path')
      .data(contours.slice(1))
      .join('path')
      .attr('fill', d => colorScale(d.value))
      .attr('d', d3.geoPath());

    return contours;
  };

  /**
   * Handler for each zoom event
   * @param e Zoom event
   */
  zoomed = async (e: d3.D3ZoomEvent<HTMLElement, unknown>) => {
    const now = performance.now();
    if (now - this.lastZoomTime < this.ZOOM_THROTTLE) {
      return;
    }
    this.lastZoomTime = now;

    if (this.zoomRafPending) {
      return;
    }

    this.zoomRafPending = true;
    requestAnimationFrame(() => {
      const transform = e.transform;
      const scaleChanged = this.curZoomTransform.k !== transform.k;
      const isPanningOnly = !scaleChanged;
      this.curZoomTransform = transform;

      // Hide tooltips with smooth ease-out when zoom/pan starts
      this.hideTooltipsWithEaseOut();

      // === REAL-TIME OPERATIONS (always execute immediately) ===
      // Transform the SVG elements (contours, backgrounds)
      this.svg.select('.umap-group').attr('transform', `${transform.toString()}`);

      // Transform the top SVG elements
      this.topSvg
        .select('.top-group')
        .attr('transform', `${transform.toString()}`);

      // Transform the visible canvas elements (points - keep real-time for scaling)
      if (anyTrue(this.showPoints)) {
        if (this.frontPositionBuffer && this.frontTextureCoordinateBuffer) {
          // For Safari: skip expensive image scaling during real-time zoom, only do position transforms
          if (this.isSafari) {
            // Only update transforms, not image scaling - deferred operations will handle full redraw
            this.updatePointTransformsOnly();
          } else {
            this.drawScatterPlot(isPanningOnly);
          }
        }
      }

      // Update the selected point highlight to scale with zoom (real-time for selection feedback)
      this.updateSelectedPointHighlight();

      // === REAL-TIME OPERATIONS FOR SEARCH RESULTS ===
      // Update search scatter plot immediately to prevent misalignment
      if (!this.searchPointCanvas.classed('hidden')) {
        this.drawSearchScatterPlot();
      }

      // === GRID UPDATES: ALWAYS IMMEDIATE ===
      // Adjust the canvas grid based on the zoom level
      if (this.showGrid) {
        this.redrawTopicGrid();
      }

      // Adjust the highlighted tile
      if (this.showGrid && this.lastMouseClientPosition && !this.hideHighlights) {
        this.mouseoverLabel(
          this.lastMouseClientPosition.x,
          this.lastMouseClientPosition.y
        );
      }

      // === SAFARI OPTIMIZATION: DEFERRED OPERATIONS ===
      if (this.isSafari) {
        // Clear any existing deferred timeout
        if (this.deferredZoomTimeout !== null) {
          window.clearTimeout(this.deferredZoomTimeout);
        }


        // Schedule expensive operations to run after zoom stops
        this.deferredZoomTimeout = window.setTimeout(() => {
          // Ensure we're still in Safari and zoom has actually stopped
          this.performDeferredZoomOperations(isPanningOnly);
          this.deferredZoomTimeout = null;
        }, this.DEFERRED_ZOOM_DELAY);
      } else {
        // Chrome and other browsers: execute immediately
        this.performDeferredZoomOperations(isPanningOnly);
      }

      // === Task (2) ===
      // Update the footer with the new zoom level
      if (scaleChanged) {
        // Debounce the footer update
        if (this.zoomTimeout !== null) {
          window.clearTimeout(this.zoomTimeout);
        }
        this.zoomTimeout = window.setTimeout(() => {
          this.footerStoreValue.curZoomTransform = this.curZoomTransform;
          this.footerStore.set(this.footerStoreValue);
          this.zoomTimeout = null;
        }, 100);
      }

      this.zoomRafPending = false;
    });
  };

  /**
   * Perform expensive zoom operations that can be deferred in Safari
   * @param isPanningOnly Whether this is just a pan operation
   */
  private performDeferredZoomOperations = (isPanningOnly: boolean) => {
    // For Safari: Now perform the full image scaling and node size updates after zoom has stopped
    if (this.isSafari && anyTrue(this.showPoints)) {
      if (this.frontPositionBuffer && this.frontTextureCoordinateBuffer) {
        // Force a complete redraw with proper node sizing
        this.drawScatterPlot(false); // Pass false to ensure full redraw, not just panning optimization
      }
    }

    // Search scatter plot is now updated in real-time to prevent misalignment

    // Adjust the label size based on the zoom level
    if (this.showLabel) {
      this.layoutTopicLabels(this.userMaxLabelNum, true);
    }

    // Adjust the highlighted point
    if (
      anyTrue(this.showPoints) &&
      this.lastMouseClientPosition &&
      !this.hideHighlights
    ) {
      const { x, y } = this.lastMouseClientPosition;
      this.mouseoverPoint(x, y);
      this.updateHighlightPoint();
    }

    // For Safari: Update highlights after deferred operations complete
    if (this.isSafari) {
      this.updateSelectedPointHighlight();
    }

    // Show label summaries
    if (this.labelSummariesVisible !== null) {
      this.showLabelSummaries(!!this.labelSummariesVisible);
    }
  };

  /**
   * Update only point transforms without scaling images (Safari optimization)
   */
  private updatePointTransformsOnly = () => {
    // Only update the transform attribute of point groups, don't touch image scaling
    const pointGroup = this.topSvg.select('g.points');
    if (!pointGroup.empty()) {
      pointGroup
        .attr('transform', this.curZoomTransform ? this.curZoomTransform.toString() : '');

      // Update point positions without touching image attributes
      pointGroup
        .selectAll<SVGGElement, PromptPoint>('g.point')
        .attr('transform', (d: PromptPoint) => {
          const x = this.xScale(d.x);
          const y = this.yScale(d.y);
          return `translate(${x},${y})`;
        });

      // Update tooltip positions during zoom/pan for smooth following
      this.updateTooltipPositions();
    }
  };

  /**
   * Hide tooltips with ease-out transition (called when zoom/pan starts)
   */
  hideTooltipsWithEaseOut = () => {
    // Clear any pending tooltip show timers
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }

    // Hide tooltips with smooth ease-out transition to match the ease-in when reappearing
    if (this.clickedPoint) {
      this.tooltipClicked.style.transition = 'opacity 150ms ease-out, visibility 150ms ease-out';
      this.tooltipClicked.classList.add('hidden');
    }

    if (this.hoverPoint) {
      this.tooltipTop.style.transition = 'opacity 150ms ease-out, visibility 150ms ease-out';
      this.tooltipTop.classList.add('hidden');
    }
  };

  /**
   * Update tooltip positions for clicked and hovered points after zoom/pan
   */
  updateTooltipPositions = () => {
    // Clear any existing timer
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }

    // Wait 0.5 seconds before showing tooltips
    this.tooltipShowTimer = window.setTimeout(() => {
      // Update clicked point tooltip
      if (this.clickedPoint) {
        const clickedElement = this.topSvg
          .selectAll('g.point')
          .filter((d: any) => d.id === this.clickedPoint?.id);

        if (!clickedElement.empty()) {
          const clickedNode = clickedElement.node();
          if (clickedNode) {
            const tooltipContent = `<div style="color: black;">${this.clickedPoint.name}</div>`;

            // Update position first
            updatePopperTooltip(
              this.tooltipClicked,
              clickedNode as HTMLElement,
              tooltipContent,
              'top'
            );

            // Re-enable transitions and show with fade-in
            setTimeout(() => {
              this.tooltipClicked.style.transition = '';
              this.tooltipClicked.classList.remove('hidden');
            }, 10); // Small delay to ensure position update is applied
          }
        }
      }

      // Update hover point tooltip
      if (this.hoverPoint) {
        const hoverElement = this.topSvg
          .selectAll('g.point')
          .filter((d: any) => d.id === this.hoverPoint?.id);

        if (!hoverElement.empty()) {
          const hoverNode = hoverElement.node();
          if (hoverNode && this.hoverPoint.tooltipInfo) {
            // Update position first
            updatePopperTooltip(
              this.tooltipTop,
              hoverNode as HTMLElement,
              this.hoverPoint.tooltipInfo,
              'top'
            );

            // Re-enable transitions and show with fade-in
            setTimeout(() => {
              this.tooltipTop.style.transition = '';
              this.tooltipTop.classList.remove('hidden');
            }, 10); // Small delay to ensure position update is applied
          }
        }
      }

      this.tooltipShowTimer = null;
    }, 500); // 0.5 second delay
  };

  /**
   * Event handler for zoom ended
   */
  zoomEnded = () => {
    // Clear any pending deferred operations since zoom has ended
    if (this.deferredZoomTimeout !== null) {
      window.clearTimeout(this.deferredZoomTimeout);
      this.deferredZoomTimeout = null;
    }

    // Execute final operations immediately for both Safari and Chrome
    // For Safari: ensure final redraw with proper node sizes
    if (this.isSafari && anyTrue(this.showPoints)) {
      if (this.frontPositionBuffer && this.frontTextureCoordinateBuffer) {
        this.drawScatterPlot(false); // Force complete redraw
      }
      // Update highlights after final redraw
      this.updateSelectedPointHighlight();
      if (this.lastMouseClientPosition && !this.hideHighlights) {
        const { x, y } = this.lastMouseClientPosition;
        this.mouseoverPoint(x, y);
        this.updateHighlightPoint();
      }
    }

    // Adjust the label size based on the zoom level
    if (this.showLabel) {
      this.layoutTopicLabels(this.userMaxLabelNum, false);
    }

    if (this.labelSummariesVisible !== null) {
      this.showLabelSummaries(!!this.labelSummariesVisible);
    }

    // Update tooltip positions after zoom/pan
    this.updateTooltipPositions();
  };

  /**
   * Handle messages from the embedding worker
   * @param e Message event
   */
  loaderWorkerMessageHandler = (e: MessageEvent<LoaderWorkerMessage>) => {
    switch (e.data.command) {
      case 'transferLoadData': {
        // Add these points to the quadtree ASAP
        const treeMessage: TreeWorkerMessage = {
          command: 'updateQuadtree',
          payload: {
            points: e.data.payload.points
          }
        };


        this.treeWorker.postMessage(treeMessage);

        if (e.data.payload.isFirstBatch) {
          // Add the first batch points
          this.promptPoints = e.data.payload.points;

          // Capture pre-simulation positions before dispersal
          this.preSimPositions = new Map();
          for (const point of this.promptPoints) {
            this.preSimPositions.set(point.id, { x: point.x, y: point.y });
          }

          // Init WebGL buffers for all browsers
          this.initWebGLBuffers();

          if (!this.forceSimulation) {
            this.initForceSimulation();
          }
          // Update the force simulation with the first batch of points
          this.forceSimulation?.updateSimulation(this.promptPoints);

          // Draw initial scatter plot at original UMAP positions
          if (anyTrue(this.showPoints)) {
            this.drawScatterPlot();
          }

          // Fade in the points group (concurrent with dispersal animation)
          const pointsGroup = this.topSvg.select('g.points');
          if (!pointsGroup.empty()) {
            pointsGroup.style('opacity', '0');
            pointsGroup
              .transition()
              .duration(400)
              .ease(d3.easeCubicInOut)
              .style('opacity', '1');
          }

          if (this.showLabel) {
            this.layoutTopicLabels(this.userMaxLabelNum, false);
          }

          // Add the points to the search index
          const searchMessage: SearchWorkerMessage = {
            command: 'addPoints',
            payload: {
              points: e.data.payload.points
            }
          };
          this.searchWorker.postMessage(searchMessage);
        } else {
          // Batches after the first batch
          const newPoints = e.data.payload.points;
          for (const point of newPoints) {
            this.promptPoints.push(point);
          }

          // Add the points to the search index
          const searchMessage: SearchWorkerMessage = {
            command: 'addPoints',
            payload: {
              points: newPoints
            }
          };
          this.searchWorker.postMessage(searchMessage);

          // Add the new points to the WebGL buffers
          this.updateWebGLBuffers(newPoints);

          // If currently animating, cancel and re-capture positions
          if (this.isAnimatingDispersal && this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
            this.isAnimatingDispersal = false;
          }

          // Capture current visual positions as pre-sim positions for all points
          this.preSimPositions = new Map();
          for (const point of this.promptPoints) {
            this.preSimPositions.set(point.id, { x: point.x, y: point.y });
          }

          // Update the force simulation with all points
          // (onSimulationComplete will start a new animation)
          if (this.forceSimulation) {
            this.forceSimulation.updateSimulation(this.promptPoints);
          }

          // Draw scatter plot to create SVG elements for new points
          if (anyTrue(this.showPoints)) {
            this.drawScatterPlot();
          }

          if (e.data.payload.isLastBatch) {
            this.rebuildPointQuadtree();
          }
        }

        // Update the data point count
        this.loadedPointCount = this.promptPoints.length;

        // Update the footer
        this.footerStoreValue.numPoints = this.promptPoints.length;
        this.footerStoreValue.promptPoints = this.promptPoints;
        this.footerStore.set(this.footerStoreValue);
        break;
      }

      default: {
        console.error('Unknown message', e.data.command);
        break;
      }
    }
  };

  /**
   * Handle messages from the embedding worker
   * @param e Message event
   */
  treeWorkerMessageHandler = (e: MessageEvent<TreeWorkerMessage>) => {
    switch (e.data.command) {
      case 'finishInitQuadtree': {
        // Tell the loader worker to start loading data
        // (need to wait to set up the quadtree to avoid racing)
        // Inline workers use blob: URLs, so relative paths won't resolve.
        // Convert to absolute URL before sending to the worker.
        const pointUrl = this.dataURLs.point.startsWith('http')
          ? this.dataURLs.point
          : `${window.location.origin}${this.dataURLs.point}`;
        const message: LoaderWorkerMessage = {
          command: 'startLoadData',
          payload: { url: pointUrl }
        };
        this.loaderWorker.postMessage(message);
        break;
      }

      case 'finishQuadtreeSearch': {
        if (this.lastMouseClientPosition === null) {
          console.warn('loaderWorkerMessageHandler: lastMouseClientPosition is null');
          return;
        }
        // Check if the closest point is relatively close to the mouse
        const closestPoint = structuredClone(
          e.data.payload.point
        ) as PromptPoint;
        const screenPointX = this.curZoomTransform.applyX(
          this.xScale(closestPoint.x)
        );
        const screenPointY = this.curZoomTransform.applyY(
          this.yScale(closestPoint.y)
        );

        const distance = Math.max(
          Math.abs(screenPointX - this.lastMouseClientPosition.x),
          Math.abs(screenPointY - this.lastMouseClientPosition.y)
        );

        const highlightRadius = Math.max(
          10 / this.curZoomTransform.k,
          (config.layout.scatterDotRadius *
            Math.exp(Math.log(this.curZoomTransform.k) * 0.55)) /
          this.curZoomTransform.k
        );

        // Highlight the point if it is close enough to the mouse
        const curHoverRadius = Math.max(
          HOVER_RADIUS,
          highlightRadius * this.curZoomTransform.k
        );

        if (distance <= curHoverRadius) {
          this.highlightPoint({ point: closestPoint, animated: false });
        }
        break;
      }

      default: {
        console.error('Unknown message', e.data.command);
        break;
      }
    }
  };

  

  /**
   * Handle messages from the embedding worker
   * @param e Message event
   */
  searchWorkerMessageHandler = (e: MessageEvent<SearchWorkerMessage>) => {
    switch (e.data.command) {
      case 'checkModelStatus': {
        const { isLoaded } = e.data.payload;

        if (isLoaded) {
          startPlaceholderRotation();
        }
        break;
      }
      case 'finishQuery': {
        const { resultIndexes, scores } = e.data.payload;
        const resultPoints: PromptPoint[] = [];

        // Check if resultIndexes is defined before using it
        if (resultIndexes) {
          for (const resultIndex of resultIndexes) {
            const curPoint = this.promptPoints[resultIndex];
            resultPoints.push(curPoint);
          }
        }


        this.searchBarStoreValue.results = resultPoints;
        this.searchBarStoreValue.scores = scores;
        this.searchBarStoreValue.shown = true;
        this.searchBarStore.set(this.searchBarStoreValue);

        // Draw the scatter plot
        this.searchPointCanvas.classed('hidden', false);
        this.searchPointResults = resultPoints;
        this.drawSearchScatterPlot();
        break;
      }

      default: {
        console.error('Unknown message', e.data.command);
        break;
      }
    }
  };

  /**
   * Start a query for mouse overed point
   * @param x Mouse x coordinate
   * @param y Mouse y coordinate
   */
  mouseoverPoint = (x: number, y: number) => {
    // Invert to the stage scale => invert to the data scale
    const dataX = this.xScale.invert(this.curZoomTransform.invertX(x));
    const dataY = this.yScale.invert(this.curZoomTransform.invertY(y));

    // Use local quadtree for O(log n) nearest-neighbor lookup
    if (this.pointQuadtree && this.promptPoints.length > 0) {
      const closestPoint = this.pointQuadtree.find(dataX, dataY);

      if (closestPoint) {
        // Only highlight if the point is close enough on screen
        const screenPointX = this.curZoomTransform.applyX(this.xScale(closestPoint.x));
        const screenPointY = this.curZoomTransform.applyY(this.yScale(closestPoint.y));

        const screenDistance = Math.sqrt(
          Math.pow(x - screenPointX, 2) +
          Math.pow(y - screenPointY, 2)
        );

        const hoverThreshold = Math.max(
          7 / this.curZoomTransform.k,
          this.curPointWidth * 2
        );

        if (screenDistance <= hoverThreshold) {
          this.highlightPoint({ point: closestPoint, animated: false });
        }
      }

      return;
    }

    // Original code for the case when no points are available
    // Let the worker to search the closest point in a radius
    let groupID = -1;

    if (this.groupNames) {
      if (allTrue(this.showPoints)) {
        groupID = -1;
      } else {
        // TODO: Need a better way to search slices of groups for multi groups
        for (let i = 0; i < this.showPoints.length; i++) {
          if (this.showPoints[i]) {
            groupID = i;
            break;
          }
        }
      }
    }

    const message: TreeWorkerMessage = {
      command: 'startQuadtreeSearch',
      payload: {
        x: dataX,
        y: dataY,
        time: this.timeInspectMode && this.curTime ? this.curTime : '',
        groupID: groupID
      }
    };
    this.treeWorker.postMessage(message);
  };

  /**
   * Event handler for mousemove
   * @param e Mouse event
   */
  mousemoveHandler = (e: MouseEvent) => {
    const now = performance.now();
    if (now - this.lastMouseMoveTime < this.MOUSE_MOVE_THROTTLE) {
      return;
    }
    this.lastMouseMoveTime = now;

    if (this.rafPending) {
      return;
    }

    this.rafPending = true;
    requestAnimationFrame(() => {
      // Show tooltip when mouse over a data point on canvas
      const x = e.offsetX;
      const y = e.offsetY;
      this.lastMouseClientPosition = { x: x, y: y };

      // Show point highlight
      if (anyTrue(this.showPoints) && !this.hideHighlights) {
        this.mouseoverPoint(x, y);
      }

      // Show labels
      if (!this.hideHighlights) {
        this.mouseoverLabel(x, y);
      }

      this.rafPending = false;
    });
  };

  /**
   * Get the current zoom viewing box
   * @returns Current zoom view box
   */
  getCurZoomBox = () => {
    const box: Rect = {
      x: this.curZoomTransform.invertX(0),
      y: this.curZoomTransform.invertY(0),
      width: Math.abs(
        this.curZoomTransform.invertX(this.svgFullSize.width) -
        this.curZoomTransform.invertX(0)
      ),
      height: Math.abs(
        this.curZoomTransform.invertY(this.svgFullSize.height) -
        this.curZoomTransform.invertY(0)
      )
    };
    return box;
  };

  /**
   * Get the current viewing area's zoom viewing box
   * @returns Current zoom view box
   */
  getCurViewingZoomBox = () => {
    const box: Rect = {
      x: this.curZoomTransform.invertX(config.layout.searchPanelWidth),
      y: this.curZoomTransform.invertY(config.layout.topBarHeight),
      width: Math.abs(
        this.curZoomTransform.invertX(this.svgFullSize.width) -
        this.curZoomTransform.invertX(config.layout.searchPanelWidth)
      ),
      height: Math.abs(
        this.curZoomTransform.invertY(this.svgFullSize.height) -
        this.curZoomTransform.invertY(config.layout.topBarHeight)
      )
    };
    return box;
  };

  /**
   * Get the current view ranges [xmin, xmax, ymin, ymax] in the data coordinate
   * @returns Current view box in the data coordinate
   */
  getCurViewRanges = (): [number, number, number, number] => {
    const zoomBox = this.getCurZoomBox();

    const xMin = this.xScale.invert(zoomBox.x);
    const xMax = this.xScale.invert(zoomBox.x + zoomBox.width);
    const yMin = this.yScale.invert(zoomBox.y + zoomBox.height);
    const yMax = this.yScale.invert(zoomBox.y);

    const result: [number, number, number, number] = [xMin, xMax, yMin, yMax];
    return result;
  };

  /**
   * Handle user changing the display setting
   * @param checkbox Checkbox name
   * @param checked Whether this checkbox is checked
   */
  displayCheckboxChanged = (
    checkbox: string,
    checked: boolean,
    group: string | undefined = undefined
  ) => {
    switch (checkbox) {
      case 'contour': {
        if (group !== undefined) {
          // Users have specified groups
          if (this.groupNames) {
            const groupIndex = this.groupNames?.indexOf(group);
            this.showContours[groupIndex] = checked;
            this.svg
              .select(`g.contour-group-${group}`)
              .classed('hidden', !this.showContours[groupIndex]);

            if (this.showLabel) {
              this.layoutTopicLabels(this.userMaxLabelNum, true);
            }
          }
        } else {
          this.showContours = new Array<boolean>(this.showContours.length).fill(
            checked
          );

          const contourGroup = this.svg
            .select('g.contour-group')
            .style('opacity', null)
            .classed('hidden', !this.showContours[0]);

          this.svg
            .select('g.contour-group-time')
            .classed('hidden', !this.showContours[0]);

          if (this.timeInspectMode && this.showContours[0]) {
            contourGroup.style('opacity', 0.4);
          }
        }

        if (this.showGrid) {
          let startColor: string;
          let endColor: string;

          if (anyTrue(this.showContours)) {
            // No contour -> contour | dark -> light
            startColor = config.gridColorDark;
            endColor = config.gridColorLight;
          } else {
            // Contour -> no contour | light -> dark
            startColor = config.gridColorLight;
            endColor = config.gridColorDark;
          }

          const duration = 300;
          const colorScale = d3.interpolateHsl(startColor, endColor);
          requestAnimationFrame(time => {
            this.drawTopicGridFrame(time, null, duration, colorScale);
          });
        }
        break;
      }

      case 'point': {
        if (group !== undefined) {
          if (this.groupNames === null) {
            throw Error('groupNames is null');
          }
          // Only show one group's point
          const groupIndex = this.groupNames.indexOf(group);
          this.showPoints[groupIndex] = checked;
        } else {
          this.showPoints = new Array<boolean>(this.showPoints.length).fill(
            checked
          );
        }

        this.pointCanvas
          .classed('hidden', !anyTrue(this.showPoints))
          .classed('faded', anyTrue(this.showPoints) && this.showLabel);

        this.drawScatterPlot();

        if (this.showGrid) this.redrawTopicGrid();
        break;
      }

      case 'grid': {
        this.showGrid = checked;
        this.topicCanvases.forEach(c => c.classed('hidden', !this.showGrid));

        if (this.showGrid) {
          this.redrawTopicGrid();
        }

        break;
      }

      case 'label': {
        this.showLabel = checked;
        this.topSvg
          .select('g.top-content g.topics')
          .classed('hidden', !this.showLabel);

        this.pointCanvas.classed(
          'faded',
          anyTrue(this.showPoints) && this.showLabel
        );

        if (this.showLabel) {
          this.layoutTopicLabels(this.userMaxLabelNum, false);
        }
        break;
      }
      case 'resInfo': {
        //////
      }

      case 'time': {
        this.timeInspectMode = checked;

        // Hide the old contour if it's shown
        // TODO: need to handle multiple groups + time
        if (anyTrue(this.showContours)) {
          if (this.timeInspectMode) {
            this.svg.select('g.contour-group').style('opacity', 0.4);
          } else {
            this.svg.select('g.contour-group').style('opacity', null);
          }

          this.svg
            .select('g.contour-group-time')
            .classed('hidden', !this.timeInspectMode);
        }

        this.drawScatterPlot();

        // If the user enters the time inspect mode, automatically start the
        // slider animation
        if (this.timeInspectMode) {
          this.playPauseClickHandler(true);
        }
        break;
      }

      default: {
        console.error('Unknown checkbox name', checkbox);
        break;
      }
    }

    this.updateEmbedding();
  };

  /**
   * Initialize the force simulation (unified for all browsers)
   */
  initForceSimulation() {
    this.forceSimulation = new PointForceSimulation({
      radiusFunction: () => {
        return this.curPointWidth / 4;
      }
    });

    // No visual updates during simulation ticks — runs silently
    this.forceSimulation.onTick(() => {});

    this.forceSimulation.onEnd(() => {
      this.onSimulationComplete();
    });
  }

  /**
   * Called when the force simulation finishes.
   * Captures final positions, resets to pre-sim, and starts smooth animation.
   */
  private onSimulationComplete() {
    // Capture final dispersed positions
    this.postSimPositions = new Map();
    for (const point of this.promptPoints) {
      this.postSimPositions.set(point.id, { x: point.x, y: point.y });
    }

    // Reset points back to pre-simulation positions
    if (this.preSimPositions) {
      for (const point of this.promptPoints) {
        const pre = this.preSimPositions.get(point.id);
        if (pre) {
          point.x = pre.x;
          point.y = pre.y;
        }
      }
    }

    // Init WebGL buffers if not done yet
    if (!this.frontPositionBuffer) {
      this.initWebGLBuffers();
    }

    // Render initial frame at original positions
    this.updatePointPositionsLightweight();
    this.updatePointTransformsOnly();

    // Start the smooth dispersal animation
    this.startDispersalAnimation();
  }

  /**
   * Animate dispersal from original UMAP positions to final dispersed positions
   * using requestAnimationFrame with cubic ease-in-out.
   */
  private startDispersalAnimation() {
    if (!this.preSimPositions || !this.postSimPositions) return;

    this.isAnimatingDispersal = true;
    this.animationStartTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - this.animationStartTime;
      let t = Math.min(elapsed / this.ANIMATION_DURATION, 1.0);

      // Cubic ease-in-out
      t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      // Lerp each point from original to final position
      for (const point of this.promptPoints) {
        const pre = this.preSimPositions!.get(point.id);
        const post = this.postSimPositions!.get(point.id);
        if (pre && post) {
          point.x = pre.x + (post.x - pre.x) * t;
          point.y = pre.y + (post.y - pre.y) * t;
        }
      }

      // Lightweight rendering: WebGL buffer + SVG transforms only
      this.updatePointPositionsLightweight();
      this.updatePointTransformsOnly();

      if (t >= 1.0) {
        this.finalizeDispersalAnimation();
        return;
      }

      this.animationFrameId = requestAnimationFrame(animate);
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Update WebGL position buffer without sending tree worker message.
   * Used during animation for lightweight per-frame updates.
   */
  private updatePointPositionsLightweight() {
    if (!this.frontPositionBuffer || this.promptPoints.length === 0) return;

    const positions = new Float32Array(this.promptPoints.length * 2);
    for (let i = 0; i < this.promptPoints.length; i++) {
      positions[i * 2] = this.promptPoints[i].x;
      positions[i * 2 + 1] = this.promptPoints[i].y;
    }

    this.frontPositionBuffer.subdata(positions, 0);
  }

  /**
   * Finalize the dispersal animation: set exact final positions,
   * do a full render pass, and rebuild the quadtree.
   */
  private finalizeDispersalAnimation() {
    this.isAnimatingDispersal = false;
    this.animationFrameId = null;

    // Set exact final positions to avoid float drift
    if (this.postSimPositions) {
      for (const point of this.promptPoints) {
        const post = this.postSimPositions.get(point.id);
        if (post) {
          point.x = post.x;
          point.y = post.y;
        }
      }
    }

    // Full update: WebGL buffer + tree worker
    this.updatePointPositions();
    // Full redraw: correct image sizing, borders, clip paths
    this.drawScatterPlot(false);
    this.rebuildPointQuadtree();

    // Clean up
    this.preSimPositions = null;
    this.postSimPositions = null;
  }

  /**
   * Update WebGL buffers and tree worker with current point positions
   */
  updatePointPositions() {
    if (!this.frontPositionBuffer || this.promptPoints.length === 0) return;

    const positions = new Float32Array(this.promptPoints.length * 2);
    for (let i = 0; i < this.promptPoints.length; i++) {
      positions[i * 2] = this.promptPoints[i].x;
      positions[i * 2 + 1] = this.promptPoints[i].y;
    }

    this.frontPositionBuffer.subdata(positions, 0);

    const treeMessage: TreeWorkerMessage = {
      command: 'updateQuadtree',
      payload: {
        points: this.promptPoints
      }
    };
    this.treeWorker.postMessage(treeMessage);
  }

  showLabelSummaries(isShown: boolean) {
    // console.log("labels summaries ", isShown)
    d3.selectAll('.top-svg .topic-label').classed('labels-shown', isShown);
    this.labelSummariesVisible = isShown;
  }
}


// Array of rotating placeholder messages
const placeholderMessages = [
  "Search GT Computing Researchers",
  "Find experts by research area",
  "Discover researchers by name",
  "Try natural language queries",
  "Try 'nlp llm researchers'",
  "Try 'cybersecurity and networking'",
];

let currentMessageIndex = 0;
let placeholderIntervalId: number | null = null;
export let displaySearchText: Writable<string> = writable("Loading Embedding Model...");

// Function to rotate through placeholder messages
function rotateSearchPlaceholder() {
  currentMessageIndex = (currentMessageIndex + 1) % placeholderMessages.length;
  displaySearchText.set(placeholderMessages[currentMessageIndex]);
}

// Start rotating messages when model is loaded
export function startPlaceholderRotation() {
  // Set initial message
  displaySearchText.set(placeholderMessages[0]);

  // Rotate every 4 seconds
  placeholderIntervalId = window.setInterval(rotateSearchPlaceholder, 4000);
}

export function stopPlaceholderRotation() {
  if (placeholderIntervalId !== null) {
    clearInterval(placeholderIntervalId);
    placeholderIntervalId = null;
  }
}