import type { Writable } from 'svelte/store';
import { writable } from 'svelte/store';
import { config } from '../../config/config';
import type { PromptPoint } from '../../types/embedding-types';
import d3 from '../../utils/d3-import';
import { anyTrue } from '../../utils/utils';
import type { Embedding } from './Embedding';
import './Embedding.scss';
import { updatePopperTooltip } from './EmbeddingLabel';
import fragmentShader from './shaders/point.frag?raw';
import vertexShader from './shaders/point.vert?raw';

// import { colors } from '../../config/config';

const DEBUG = config.debug;
const BASE_URL = import.meta.env.BASE_URL;

let pointMouseenterTimer: number | null = null;
let pointMouseleaveTimer: number | null = null;
let prevHoveredPointId: string | null = null;
let lastDrawTime = 0;
const DRAW_THROTTLE = 16; // ~60fps

// Cache image aspect ratios to avoid creating new Image() on every zoom
const imageAspectRatioCache = new Map<string, number>();

/**
 * Initialize the data => stage, stage => [-1, 1] transformation matrices
 * @param this Embedding object
 */
export function initWebGLMatrices(this: Embedding) {
  // Convert the x and y scales to a matrix (applying scale is cheaper in GPU)
  const xDomainMid = (this.xScale.domain()[0] + this.xScale.domain()[1]) / 2;
  const yDomainMid = (this.yScale.domain()[0] + this.yScale.domain()[1]) / 2;

  const xRangeMid = (this.xScale.range()[0] + this.xScale.range()[1]) / 2;
  const yRangeMid = (this.yScale.range()[0] + this.yScale.range()[1]) / 2;

  const xMultiplier =
    (this.xScale.range()[1] - this.xScale.range()[0]) /
    (this.xScale.domain()[1] - this.xScale.domain()[0]);

  const yMultiplier =
    (this.yScale.range()[1] - this.yScale.range()[0]) /
    (this.yScale.domain()[1] - this.yScale.domain()[0]);

  // WebGL is column-major!
  // Transform from data space to stage space (same as applying this.xScale(),
  // and this.yScale())
  const dataScaleMatrix = [
    [xMultiplier, 0, -xMultiplier * xDomainMid + xRangeMid],
    [0, yMultiplier, -yMultiplier * yDomainMid + yRangeMid],
    [0, 0, 1]
  ];
  const dataScaleMatrix1D = dataScaleMatrix.flat();

  // Transforming the stage space to the normalized coordinate
  // Note we need to flip the y coordinate
  const normalizeMatrix = [
    [2 / this.svgFullSize.width, 0, -1],
    [0, -2 / this.svgFullSize.height, 1],
    [0, 0, 1]
  ];
  const normalizeMatrix1D = normalizeMatrix.flat();

  // Store the transformation matrix
  this.webGLMatrices = {
    dataScaleMatrix: dataScaleMatrix1D,
    normalizeMatrix: normalizeMatrix1D
  };

  // If buffers already exist, we're resizing, so update drawScatterPlot
  if (this.frontPositionBuffer) {
    this.drawScatterPlot();
  }
}

export function initWebGLBuffers(this: Embedding) {
  if (this.gridData === null) {
    console.warn('initWebGLBuffers: GridData is null.');
    return;
  }

  // Get the position and original texture coordinate for each point
  const positions: number[][] = [];
  const textureCoords: number[][] = []; // Restore this

  for (const point of this.promptPoints) {
    positions.push([point.x, point.y]);

    // Restore original texture coordinate logic
    if (this.timeTextureMap === null) {
      if (this.groupNames && point.groupID !== undefined) {
        textureCoords.push([point.groupID / this.groupNames.length, 0]);
      } else {
        textureCoords.push([0, 0]);
      }
    } else {
      if (this.timeTextureMap.has(point.time!)) {
        const u =
          this.timeTextureMap.get(point.time!)! /
          (this.timeTextureMap.size - 1);
        textureCoords.push([u, 0]);
      } else {
        textureCoords.push([1, 0]); // Default for bad points
      }
    }
  }

  let totalPointSize = this.gridData.totalPointSize;
  if (
    this.groupNames !== null &&
    this.gridData.groupTotalPointSizes !== undefined
  ) {
    for (const name of this.groupNames) {
      totalPointSize += this.gridData.groupTotalPointSizes[name];
    }
  }
  totalPointSize = Math.max(totalPointSize, this.promptPoints.length);

  this.frontPositionBuffer = this.pointRegl.buffer({
    length: totalPointSize * 4 * 2,
    type: 'float',
    usage: 'dynamic'
  });
  this.frontPositionBuffer.subdata(positions, 0);

  this.frontTextureCoordinateBuffer = this.pointRegl.buffer({
    length: totalPointSize * 4 * 2,
    type: 'float',
    usage: 'dynamic'
  });
  this.frontTextureCoordinateBuffer.subdata(textureCoords, 0);

  this.frontBufferPointSize = this.promptPoints.length;
}

/**
 * Update WebGL buffers with stream data
 * @param this Embedding object
 * @param newPoints A list of loaded new points
 */
export function updateWebGLBuffers(this: Embedding, newPoints: PromptPoint[]) {
  // Get the position and color of each new point
  const positions: number[][] = [];
  const textureCoords: number[][] = [];

  for (const point of newPoints) {
    positions.push([point.x, point.y]);

    if (this.timeTextureMap === null) {
      if (this.groupNames && point.groupID !== undefined) {
        textureCoords.push([point.groupID / this.groupNames.length, 0]);
      } else {
        textureCoords.push([0, 0]);
      }
    } else {
      if (this.timeTextureMap.has(point.time!)) {
        const u =
          this.timeTextureMap.get(point.time!)! /
          (this.timeTextureMap.size - 1);
        textureCoords.push([u, 0.5]);
      } else {
        // The last entry in the texture array is reserved for 'bad' points
        // (e.g., wrong year)
        textureCoords.push([1, 0]);
      }
    }
  }

  // Update the buffer using byte offsets
  this.frontPositionBuffer!.subdata(
    positions,
    this.frontBufferPointSize * 2 * 4
  );
  this.frontTextureCoordinateBuffer!.subdata(
    textureCoords,
    this.frontBufferPointSize * 2 * 4
  );
  this.frontBufferPointSize += newPoints.length;
}

/**
 * Draw a scatter plot for the UMAP.
 */
export function drawScatterPlot(this: Embedding, isPanningOnly = false) {
  const now = performance.now();
  if (now - lastDrawTime < DRAW_THROTTLE && !isPanningOnly) {
    return;
  }
  lastDrawTime = now;

  if (!this.webGLMatrices || !this.frontPositionBuffer || !this.frontTextureCoordinateBuffer) {
    return; // Buffers not ready
  }

  // Clear the canvas
  if (!isPanningOnly) {
    this.pointRegl.clear({
      color: [0, 0, 0, 0],
      depth: 1
    });
  }

  // Create/update SVG points with profile images
  const pointGroup = this.topSvg.select('g.points');
  if (pointGroup.empty()) {
    this.topSvg.append('g')
      .attr('class', 'points')
      .attr('transform', this.curZoomTransform ? this.curZoomTransform.toString() : '')
      .lower(); // Move points below labels in DOM order
  } else {
    pointGroup
      .attr('transform', this.curZoomTransform ? this.curZoomTransform.toString() : '')
      .lower(); // Ensure points stay below labels
  }

  // Calculate point size
  let pointCount = this.loadedPointCount;
  if (this.timeInspectMode && this.timeCountMap && this.curTime) {
    if (this.timeCountMap.has(this.curTime)) {
      pointCount = this.timeCountMap.get(this.curTime)!;
    }
  }

  // Calculate point width (using existing logic)
  const a = 8.71682071;
  const b = -0.337974871;
  this.curPointWidth = a + b * Math.log(
    config.layout.scatterDotRadius *
    (this.svgFullSize.height / 760) *
    pointCount
  );
  this.curPointWidth = Math.min(5, this.curPointWidth);
  this.curPointWidth = Math.max(0.4, this.curPointWidth);



  // const baseSize = this.curPointWidth * 1.7;
  // console.log("point width " + baseSize)
  // const zoomScaleFactor = Math.log2(this.curZoomTransform.k + 1);

  // const zoomedPointWidth = Math.max(
  //   baseSize / Math.sqrt(zoomScaleFactor),
  //   7 / this.curZoomTransform.k
  // );


  const kMin = 0.5; // min zoom scale factor
  const kMax = 40; // max zoom scale factor
  const minPointSize = 3; // min point size
  const maxPointSize = 11; // max point size

  const epsilon = 1e-9;
  const zoomScaleFactorMin = Math.log2(kMin + 1 + epsilon);
  const zoomScaleFactorMax = Math.log2(kMax + 1 + epsilon);
  const zoomScaleRange = zoomScaleFactorMax - zoomScaleFactorMin;

  const currentK = this.curZoomTransform.k;
  const currentZoomScaleFactor = Math.log2(currentK + 1 + epsilon);

  // console.log("Current K: " + currentK);
  // console.log("Current Log Scale Factor: " + currentZoomScaleFactor);

  // compute normalized zoom factor (0 to 1)
  let normalizedZoom = 0;
  if (zoomScaleRange > epsilon) { // Avoid division by zero if kMin is very close to kMax
    normalizedZoom = (currentZoomScaleFactor - zoomScaleFactorMin) / zoomScaleRange;
  } else if (currentZoomScaleFactor >= zoomScaleFactorMax) {
    normalizedZoom = 1; // If range is tiny, snap to max if above
  } // Otherwise, it stays 0 (if below min or range is tiny)

  // Clamp the normalized factor just in case k goes outside the defined min/max range
  normalizedZoom = Math.max(0, Math.min(1, normalizedZoom));
  // console.log("Normalized Zoom (0-1): " + normalizedZoom);


  // Interpolate the point size
  const zoomedPointWidth = maxPointSize - (maxPointSize - minPointSize) * normalizedZoom;

  // console.log("Calculated Point Width: " + zoomedPointWidth);

  const cappedPointWidth = Math.min(zoomedPointWidth, maxPointSize)

  // Calculate stroke width based on zoom level
  const effectiveK = Math.max(this.curZoomTransform.k, epsilon); // Ensure k is not zero or negative
  const scaledStrokeWidth = 4 / effectiveK;

  // Update points
  const points = this.topSvg.select('g.points')
    .selectAll<SVGGElement, PromptPoint>('g.point')
    .data(this.promptPoints, (d: PromptPoint) => d.id);

  // Enter new points
  const pointsEnter = points.enter()
    .append('g')
    .attr('class', 'point')
    .style('cursor', 'pointer')
    .style('pointer-events', 'all');

  // Add circular clip path for images
  pointsEnter.append('clipPath')
    .attr('id', (d: PromptPoint) => `clip-${d.id}`)
    .append('circle')
    .attr('r', cappedPointWidth);

  // Add the image with proper object-fit and positioning
  pointsEnter.append('image')
    .attr('width', cappedPointWidth * 2)
    .attr('height', cappedPointWidth * 2)
    .attr('clip-path', (d: PromptPoint) => `url(#clip-${d.id})`)
    .attr('xlink:href', (d: PromptPoint) => d.currURL || `${BASE_URL}default-scholar-profile-picture.png`)
    // .attr('xlink:href', (d: PromptPoint) => `${BASE_URL}default-scholar-profile-picture.png`)
    .attr('x', -cappedPointWidth)
    .attr('y', -cappedPointWidth)
    .style('preserveAspectRatio', 'xMidYMid slice')
    .attr('class', 'image-view')
    .each(function () {
      // Ensure image is loaded before applying styles
      const img = new Image();
      const element = this;
      img.onload = function () {
        const aspectRatio = img.width / img.height;
        const size = cappedPointWidth * 2;
        if (aspectRatio > 1) {
          // Image is wider than tall
          d3.select(element)
            .attr('height', size)
            .attr('width', size * aspectRatio)
            .attr('x', -size * aspectRatio / 2)
            .attr('y', -size / 2);
        } else {
          // Image is taller than wide
          d3.select(element)
            .attr('width', size)
            .attr('height', size / aspectRatio)
            .attr('x', -size / 2)
            .attr('y', -size / aspectRatio / 2);
        }
      };
      img.onerror = function () {
        // Fallback to blue question mark if image fails to load
        d3.select(element).attr('xlink:href', `${BASE_URL}default-scholar-profile-picture.png`);
      };
      img.src = d3.select(element).attr('xlink:href');
    });

  // Add a circular border that will also act as a mask
  // console.log("zoomed point radius ", cappedPointWidth)

  pointsEnter.append('circle')
    .attr('class', 'point-border')
    .attr('r', cappedPointWidth)
    .style('fill', 'none')
    .style('stroke', 'rgba(255, 255, 255, 0.75)')
    .style('stroke-width', `${1 / this.curZoomTransform.k}px`);

  // Update existing points
  const mergedPoints = points.merge(pointsEnter as d3.Selection<SVGGElement, PromptPoint, null, undefined>)
    .attr('transform', (d: PromptPoint) => {
      const x = this.xScale(d.x);
      const y = this.yScale(d.y);
      return `translate(${x},${y})`;
    })
    .on('mouseover', (event: MouseEvent, d: PromptPoint) => {
      event.stopPropagation();

      // Clear any leave timer when entering a point
      if (pointMouseleaveTimer !== null) {
        clearTimeout(pointMouseleaveTimer);
        pointMouseleaveTimer = null;
      }

      this.highlightPoint({ point: d, animated: true });
      currHoveredPoint.set(d);
    })
    .on('mouseout', (event: MouseEvent, d: PromptPoint) => {
      event.stopPropagation();

      // Only clear if we're not entering another point
      if (!event.relatedTarget || !d3.select(event.relatedTarget as Element).classed('point')) {
        this.highlightPoint({ point: undefined, animated: true });
      }
    })
    .on('click', (event: MouseEvent, d: PromptPoint) => {
      event.stopPropagation();
      // Call the centralized selectPoint handler
      if (this.clickedPoint && this.clickedPoint.id === d.id) {
        this.selectPoint(null);  // Unselect if clicking the same point
        currClickedPoint.set(null);  // Ensure store is updated
      } else {
        this.selectPoint(d);     // Select the new point
        currClickedPoint.set(d); // Ensure store is updated
      }
    });

  // Update clip paths and images for existing points
  mergedPoints.select('clipPath circle')
    .attr('r', cappedPointWidth);

  mergedPoints.select('image')
    .each(function () {
      const element = this;
      const src = d3.select(element).attr('xlink:href');
      const size = cappedPointWidth * 2;

      const applyAspectRatio = (aspectRatio: number) => {
        if (aspectRatio > 1) {
          d3.select(element)
            .attr('height', size)
            .attr('width', size * aspectRatio)
            .attr('x', -size * aspectRatio / 2)
            .attr('y', -size / 2);
        } else {
          d3.select(element)
            .attr('width', size)
            .attr('height', size / aspectRatio)
            .attr('x', -size / 2)
            .attr('y', -size / aspectRatio / 2);
        }
      };

      // Use cached aspect ratio if available, otherwise load the image once
      const cachedRatio = imageAspectRatioCache.get(src);
      if (cachedRatio !== undefined) {
        applyAspectRatio(cachedRatio);
      } else {
        const img = new Image();
        img.onload = function () {
          const aspectRatio = img.width / img.height;
          imageAspectRatioCache.set(src, aspectRatio);
          applyAspectRatio(aspectRatio);
        };
        img.onerror = function () {
          d3.select(element).attr('xlink:href', `${BASE_URL}default-scholar-profile-picture.png`);
        };
        img.src = src;
      }
    });

  //determine way to see if point is hovered or selected or not
  mergedPoints.select('circle.point-border')
    .attr('r', cappedPointWidth)
    .style('stroke-width', (d: PromptPoint) => {
      if ((this.hoverPoint && d.id == this.hoverPoint.id) || (this.clickedPoint && d.id == this.clickedPoint.id)) {
        return `${scaledStrokeWidth}px`;
      }
      return `${1 / this.curZoomTransform.k}px`;
    })

  points.exit().remove();

  // Update footer count
  const footerCountElement = d3.select('.footer .count');
  footerCountElement
    .select('.total-count')
    .classed('hidden', pointCount !== this.loadedPointCount);
  footerCountElement
    .select('.subset-count')
    .classed('hidden', pointCount === this.loadedPointCount)
    .text(`${pointCount} Researchers`);
}

/**
 * Draw a scatter plot for the search results.
 */
export function drawSearchScatterPlot(this: Embedding) {
  if (!this.webGLMatrices) {
    console.warn('drawSearchScatterPlot: webGLMatrices not initialized');
    return;
  }

  this.searchPointRegl.clear({
    color: [0, 0, 0, 0],
    depth: 1
  });

  // Adjust point width based on the number of points to draw
  const pointCount = this.searchPointResults.length;

  // Logarithmic regression by fitting the following three points
  // https://keisan.casio.com/exec/system/14059930226691
  // [(6e4, 2), (3e5, 1), [1.8e6, 0.5]]
  const a = 6.71682071;
  const b = -0.437974871;
  let curPointWidth =
    a +
    b *
    Math.log(
      config.layout.scatterDotRadius *
      (this.svgFullSize.height / 760) *
      pointCount
    );
  curPointWidth = Math.min(500, curPointWidth);
  const alpha = 1 / (Math.log(pointCount) / Math.log(500));

  // Get the current zoom
  const zoomMatrix = getZoomMatrix(this.curZoomTransform);

  // Create a texture array (default 3x1)
  const textureArray = [
    config.layout.timePointColorInt[0],
    config.layout.timePointColorInt[1],
    config.layout.timePointColorInt[2],
    config.layout.timePointColorInt[3] || 255,
    config.layout.secondPointColorInt[0],
    config.layout.secondPointColorInt[1],
    config.layout.secondPointColorInt[2],
    255,
    255,
    255,
    255,
    0
  ];

  const texture = this.searchPointRegl.texture({
    width: 3,
    height: 1,
    data: textureArray,
    format: 'rgba'
  });

  // Collect position and color for each point
  const positions: number[][] = [];
  const uvs: number[][] = [];

  for (const searchPoint of this.searchPointResults) {
    // Skip rendering the clicked point to avoid showing WebGL point behind the SVG image
    if (this.clickedPoint && searchPoint.id === this.clickedPoint.id) {
      continue;
    }

    // Find the corresponding main point to get its current position
    const mainPoint = this.promptPoints.find(p => p.id === searchPoint.id);
    if (mainPoint) {
      // Use the main point's current position
      positions.push([mainPoint.x, mainPoint.y]);
    } else {
      // Fallback to search point's position if main point not found
      positions.push([searchPoint.x, searchPoint.y]);
    }
    uvs.push([0, 0]);
  }

  const drawPoints = this.searchPointRegl({
    depth: { enable: false },
    stencil: { enable: false },
    frag: fragmentShader,
    vert: vertexShader,

    attributes: {
      position: positions,
      textureCoord: uvs
    },

    uniforms: {
      pointWidth: curPointWidth,
      dataScaleMatrix: this.webGLMatrices.dataScaleMatrix,
      zoomMatrix: zoomMatrix,
      normalizeMatrix: this.webGLMatrices.normalizeMatrix,
      alpha: alpha,
      userAlpha: -1,
      texture: texture
    },

    blend: {
      enable: true,
      func: {
        srcRGB: 'one',
        srcAlpha: 'one',
        dstRGB: 'one minus src alpha',
        dstAlpha: 'one minus src alpha'
      }
    },

    count: pointCount,
    primitive: 'points'
  });

  drawPoints();
}

/**
 * Update the highlight point's annotation during zooming
 */
export function updateHighlightPoint(this: Embedding) {
  if (this.hoverPoint === null) return;
  if (!anyTrue(this.showPoints)) return;
  if (this.hideHighlights) return;

  // Find the point's element and ensure it exists
  const pointElement = this.topSvg.selectAll('g.point')
    .filter((d: any) => d && d.id === this.hoverPoint?.id);

  if (!pointElement.empty()) {
    // Use the entire point element as the anchor instead of just the border
    const tooltipAnchor = pointElement.node();

    if (tooltipAnchor && this.hoverPoint?.tooltipInfo && this.tooltipTop) {
      // First make sure the tooltip is visible
      this.tooltipTop.classList.remove('hidden');

      // Then update its position
      updatePopperTooltip(
        this.tooltipTop,
        tooltipAnchor as HTMLElement,
        this.hoverPoint.tooltipInfo,
        'top'
      );
    }
  }
}

// let lastHoveredPoint: PromptPoint | null = null;

/**
 * Highlight the point where the user hovers over
 * @param point The point that user hovers over
 */
export function highlightPoint(
  this: Embedding,
  args: {
    point: PromptPoint | undefined;
    animated: boolean;
  }
) {
  const { point } = args;

  if (!anyTrue(this.showPoints)) return;
  if (point === this.hoverPoint) return;
  if (this.hideHighlights) return;

  // Clear any pending timers for mouseenter
  if (pointMouseenterTimer !== null) {
    clearTimeout(pointMouseenterTimer);
    pointMouseenterTimer = null;
  }

  // Calculate stroke width based on zoom level
  const epsilon = 1e-9;
  const effectiveK = Math.max(this.curZoomTransform.k, epsilon);
  const scaledStrokeWidth = 4 / effectiveK;

  const defaultStroke = 'rgba(255, 255, 255, 0.75)';
  const defaultStrokeWidth = `${1 / this.curZoomTransform.k}px`;

  // Helper: reset a single previous point by ID (O(1) instead of O(n))
  const resetPrevPoint = () => {
    if (prevHoveredPointId !== null) {
      const prev = this.topSvg.selectAll('g.point')
        .filter((d: any) => d && d.id === prevHoveredPointId);
      prev.classed('point-hovered', false);
      prev.select('circle.point-border')
        .interrupt()
        .style('stroke', defaultStroke)
        .style('stroke-width', defaultStrokeWidth);
      prevHoveredPointId = null;
    }
  };

  // Hovering empty space
  if (point === undefined) {
    if (pointMouseleaveTimer !== null) {
      clearTimeout(pointMouseleaveTimer);
      pointMouseleaveTimer = null;
    }

    pointMouseleaveTimer = window.setTimeout(() => {
      this.hoverPoint = null;
      currHoveredPoint.set(null);
      resetPrevPoint();
      this.tooltipTop.classList.add('hidden');
      pointMouseleaveTimer = null;
    }, 100) as unknown as number;

    return;
  }

  // Entering a new point — cancel any pending leave
  if (pointMouseleaveTimer !== null) {
    clearTimeout(pointMouseleaveTimer);
    pointMouseleaveTimer = null;
  }

  // Reset only the previously hovered point
  resetPrevPoint();

  this.hoverPoint = point;
  currHoveredPoint.set(point);

  const resToolTipInfo = `
<div style="color: black;">${point.name}</div>`;
  this.hoverPoint!.tooltipInfo = resToolTipInfo;

  // Find and update the new point's visual state
  const pointElement = this.topSvg.selectAll('g.point')
    .filter((d: any) => d && d.id === point.id);

  if (!pointElement.empty()) {
    pointElement.classed('point-hovered', true);
    prevHoveredPointId = point.id;

    // Instant border change — no D3 transition delay
    pointElement.select('circle.point-border')
      .interrupt()
      .style('stroke', 'hsl(220, 60%, 35%)')
      .style('stroke-width', `${scaledStrokeWidth}px`);

    // Update tooltip
    const tooltipAnchor = pointElement.node();
    if (tooltipAnchor && this.hoverPoint && this.hoverPoint.tooltipInfo) {
      updatePopperTooltip(
        this.tooltipTop,
        tooltipAnchor as HTMLElement,
        this.hoverPoint.tooltipInfo,
        'top'
      );
      this.tooltipTop.classList.remove('hidden');
    }
  }
}

/**
 * Convert the current zoom transform into a matrix
 * @param zoomTransform D3 zoom transform
 * @returns 1D matrix
 */
const getZoomMatrix = (zoomTransform: d3.ZoomTransform) => {
  // Transforming the stage space based on the current zoom transform
  const zoomMatrix = [
    [zoomTransform.k, 0, zoomTransform.x],
    [0, zoomTransform.k, zoomTransform.y],
    [0, 0, 1]
  ];
  const zoomMatrix1D = zoomMatrix.flat();
  return zoomMatrix1D;
};

export let currHoveredPoint: Writable<PromptPoint | null> = writable(null);
export let currClickedPoint: Writable<PromptPoint | null> = writable(null);