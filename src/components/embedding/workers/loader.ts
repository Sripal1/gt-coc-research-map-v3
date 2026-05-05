import * as marked from 'marked';
import { config } from '../../../config/config';
import type {
  LoaderWorkerMessage,
  PromptPoint,
  UMAPPointStreamData
} from '../../../types/embedding-types';
import {
  parseJSONTransform,
  splitStreamTransform,
  timeit
} from '../../../utils/utils';


const DEBUG = config.debug;
const POINT_THRESHOLD = 5000;

let pendingDataPoints: PromptPoint[] = [];
let loadedPointCount = 0;
let sentPointCount = 0;

/**
 * Extract Google Scholar ID from URL and return local image path
 * @param googleScholarURL - The original Google Scholar image URL
 * @returns Local image path or fallback to original URL
 */
function getResearcherProfilePicPath(googleScholarURL: string): string {
  try {
    // Check if this is a Google Scholar URL with user parameter
    const userMatch = googleScholarURL.match(/[?&]user=([^&]+)/);
    if (userMatch) {
      const googleScholarId = userMatch[1];
      // Return local image path (use BASE_URL for correct path on GitHub Pages)
      return `${import.meta.env.BASE_URL}images/researchers/${googleScholarId}.jpg`;
    }

    // Fallback to original URL if we can't extract scholar ID
    else {
      console.warn('Cannot find scholar ID from URL: ', googleScholarURL)
      return googleScholarURL;
    }
  } catch (error) {
    console.warn('Error parsing image URL:', googleScholarURL, error);
    return googleScholarURL;
  }
}

let lastDrawnPoints: PromptPoint[] | null = null;

/**
 * Handle message events from the main thread
 * @param e Message event
 */
self.onmessage = (e: MessageEvent<LoaderWorkerMessage>) => {
  // Stream point data
  switch (e.data.command) {
    case 'startLoadData': {
      timeit('Stream data', DEBUG);

      const url = e.data.payload.url;
      startLoadData(url);
      break;
    }

    default: {
      console.error('Worker: unknown message', e.data.command);
      break;
    }
  }
};

/**
 * Start loading the large UMAP data
 * @param url URL to the NDJSON file
 */
const startLoadData = (url: string) => {
  fetch(url).then(async response => {
    if (!response.ok) {
      console.error('Failed to load data', response);
      return;
    }

    const reader = response.body
      ?.pipeThrough(new TextDecoderStream())
      ?.pipeThrough(splitStreamTransform('\n'))
      ?.pipeThrough(parseJSONTransform())
      ?.getReader();

    while (true && reader !== undefined) {
      const result = await reader.read();
      const point = result.value as UMAPPointStreamData;
      const done = result.done;

      if (done) {
        timeit('Stream data', DEBUG);
        pointStreamFinished();
        break;
      } else {
        processPointStream(point);

        // // TODO: Remove me in prod
        // if (loadedPointCount >= 32) {
        //   pointStreamFinished();
        //   timeit('Stream data', DEBUG);
        //   break;
        // }
      }
    }
  }).catch(error => {
    console.error('Error loading data:', error);  // Debug log
  });
};

/**
 * Parse an embedding string into an array of numbers
 * Handles various formats including escaped strings and removes non-numeric parts
 * @param embeddingStr The embedding string to parse
 * @returns Array of numbers or empty array if parsing fails
 */
const parseEmbeddingString = (embeddingStr: string | number | number[]): number[] => {
  // If it's already an array of numbers, return it
  if (Array.isArray(embeddingStr) && typeof embeddingStr[0] === 'number') {
    return embeddingStr as number[];
  }

  // Handle string format
  if (typeof embeddingStr === 'string') {
    try {
      // Remove any extra quotes and backslashes
      let cleanStr = embeddingStr.replace(/^\\"|"\\$|^"|"$/g, '');

      // Make sure it starts with [ and ends with ]
      if (!cleanStr.startsWith('[') || !cleanStr.endsWith(']')) {
        cleanStr = '[' + cleanStr + ']';
      }

      // Try to parse as JSON first
      try {
        return JSON.parse(cleanStr);
      } catch (e) {
        // If that fails, use a regex to extract all numbers
        const numberRegex = /-?\d+\.\d+|-?\d+/g;
        const matches = cleanStr.match(numberRegex);
        if (matches) {
          return matches.map(Number);
        }
      }
    } catch (e) {
      console.error('Error parsing embedding string:', e);
    }
  }

  // Return empty array if parsing fails
  return [];
};

/**
 * Process one data point
 * @param point Loaded data point
 */
const processPointStream = (point: UMAPPointStreamData) => {
  let researcherName: string = point[4]
  let resInterests: string = "No defined research interests"

  if (point[2].length > 0) {
    resInterests = point[2];
  }

  let resFullInfo = researcherName + ": " + resInterests

  const promptPoint: PromptPoint = {
    x: point[0],
    y: point[1],
    prompt: resFullInfo,
    id: loadedPointCount,
    tooltipInfo: resFullInfo,
  };

  // Use the helper function to parse the embedding string
  promptPoint.currEmbedding = parseEmbeddingString(point[point.length - 1]);
  promptPoint.name = researcherName;
  // Parse the original image URL to extract Google Scholar ID and use local image
  // Handle both array format ["url"] and string format "url"
  let originalURL = point[6];
  if (Array.isArray(originalURL)) {
    // If it's an actual array, take the first element
    originalURL = originalURL[0];
  } else if (typeof originalURL === 'string') {
    // Remove array brackets and quotes: ["url"] -> url or ['url'] -> url
    originalURL = originalURL.replace(/^\[["']?/, '').replace(/["']?\]$/, '');
  }
  promptPoint.currURL = getResearcherProfilePicPath(originalURL);
  promptPoint.currCitationCount = point[5]
  promptPoint.currSummary = marked.parse(point[7]) as string
  promptPoint.currKeywords = point[2]
  promptPoint.googleScholarURLs = point[8]
  promptPoint.googleScholarKeywords = point[9]
  promptPoint.currAffiliations = point[10]
  promptPoint.homePageURL = point[11]



  // if (point.length > 4) {
  //   promptPoint.time = point[3]!;
  // }


  // if (point.length > 5) {
  //   promptPoint.groupID = point[4]!;
  // }
  // promptPoint.name = researcherName;

  pendingDataPoints.push(promptPoint);
  loadedPointCount += 1;

  // Notify the main thread if we have load enough data
  if (pendingDataPoints.length >= POINT_THRESHOLD) {
    const result: LoaderWorkerMessage = {
      command: 'transferLoadData',
      payload: {
        isFirstBatch: lastDrawnPoints === null,
        isLastBatch: false,
        points: pendingDataPoints,
        loadedPointCount
      }
    };
    postMessage(result);

    sentPointCount += pendingDataPoints.length;
    lastDrawnPoints = pendingDataPoints.slice();
    pendingDataPoints = [];
  }
};

/**
 * Construct tree and notify the main thread when finish reading all data
 */
const pointStreamFinished = () => {
  // Send any left over points

  const result: LoaderWorkerMessage = {
    command: 'transferLoadData',
    payload: {
      isFirstBatch: lastDrawnPoints === null,
      isLastBatch: true,
      points: pendingDataPoints,
      loadedPointCount
    }
  };
  postMessage(result);

  sentPointCount += pendingDataPoints.length;
  lastDrawnPoints = pendingDataPoints.slice();
  pendingDataPoints = [];
}
