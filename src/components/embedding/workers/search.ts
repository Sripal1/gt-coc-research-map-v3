import { pipeline } from '@huggingface/transformers';
import computeCosineSimilarity from 'compute-cosine-similarity';
import type * as Flexsearch from 'flexsearch';
import Index from 'flexsearch';
import { config } from '../../../config/config';
import type {
  PromptPoint,
  SearchWorkerMessage
} from '../../../types/embedding-types';

const index: Flexsearch.Index<string> = new Index() as Flexsearch.Index<string>;
const DEBUG = config.debug;

const embeddings: { [id: number]: number[] } = {};
let embeddingModel: any = null;
let isModelLoaded = false;



async function getEmbeddingModel() {
  if (!embeddingModel) {
    console.log('Loading embedding model...');
    embeddingModel = await pipeline('feature-extraction', 'Xenova/gte-small');
    isModelLoaded = true;
    console.log('Embedding model loaded successfully! isModelLoaded =', isModelLoaded);
    const message: SearchWorkerMessage = {
      command: 'checkModelStatus',
      payload: {
        isLoaded: true
      }
    };
    self.postMessage(message);
  } else {
    console.log('Model already loaded, isModelLoaded =', isModelLoaded);
  }
  return embeddingModel;
}

async function getTextEmbedding(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}


/**
 * Handle message events from the main thread
 * @param e Message event
 */
self.onmessage = async (e: MessageEvent<SearchWorkerMessage>) => {
  // Stream point data
  switch (e.data.command) {
    case 'checkModelStatus': {
      await getEmbeddingModel();
      break;
    }
    case 'addPoints': {
      const { points } = e.data.payload;
      addPoints(points);
      break;
    }

    case 'startQuery': {
      const { query, queryID } = e.data.payload;
      searchPoint(query, queryID);
      break;
    }

    default: {
      console.error('Worker: unknown message', e.data);
      break;
    }
  }
};
/**
 * Add new points to the search index
 * @param points New points
 */

const addPoints = (points: PromptPoint[]) => {
  for (const point of points) {
    // Add to FlexSearch lexical index - include researcher ai generated summary in search
    if (point.prompt) {
      const searchableText = point.prompt + (point.currSummary ? ' ' + point.currSummary : '');
      index.add(point.id, searchableText);
    }

    // Add to semantic index if embedding exists
    if (point.currEmbedding) {
      // Ensure embedding is a number array
      let embedding: number[] | null = null;

      // If it's already a number array, use it directly
      if (Array.isArray(point.currEmbedding) && typeof point.currEmbedding[0] === 'number') {
        embedding = point.currEmbedding as number[];
      }
      // If it's a string, parse it to number array
      else if (typeof point.currEmbedding === 'string') {
        try {
          // Remove any extra quotes and parse as JSON
          const cleanStr = (point.currEmbedding as string).replace(/^\\"|"\\$|^"|"$/g, '');
          const parsed = JSON.parse(cleanStr);
          if (Array.isArray(parsed) && typeof parsed[0] === 'number') {
            embedding = parsed;
          }
        } catch (error) {
          console.warn('Failed to parse embedding string for point', point.id);
          continue;
        }
      }

      // Store the embedding if it's valid
      if (embedding && Array.isArray(embedding)) {
        embeddings[point.id] = embedding;
      } else {
        console.warn('Invalid embedding format for point', point.id);
      }
    }
  }
};

/**
 * Start a query
 * @param query Query string
 * @param queryID Query ID
 */
const searchPoint = async (query: string, queryID: number) => {
  try {
    // Perform FlexSearch lexical search
    const lexicalResults = index.search(query, { limit: 100 });
    const lexicalScores: { [id: number]: number } = {};

    // Assign scores to lexical results (higher score for earlier results)
    if (Array.isArray(lexicalResults)) {
      lexicalResults.forEach((id, index) => {
        const numId = typeof id === 'string' ? parseInt(id) : id;
        lexicalScores[numId] = 1 - (index / lexicalResults.length);
      });
    }

    let semanticScores: { [id: number]: number } = {};

    // Only perform semantic search if model is loaded
    console.log('Search: isModelLoaded =', isModelLoaded, 'embeddingModel =', embeddingModel !== null);
    if (isModelLoaded) {
      console.log('Model is loaded, performing semantic search. Embeddings count:', Object.keys(embeddings).length);
      try {
        // Generate query embedding for semantic search
        const queryEmbedding: number[] = await getTextEmbedding(query);

        // Compare with all stored embeddings
        Object.entries(embeddings).forEach(([id, embedding]) => {
          const similarity = computeCosineSimilarity(queryEmbedding, embedding);
          if (similarity !== null) {
            semanticScores[parseInt(id)] = similarity;
          }
        });
        console.log('Semantic search completed. Results:', Object.keys(semanticScores).length);
      } catch (error) {
        console.warn('Semantic search failed, using lexical search only:', error);
      }
    } else {
      console.log('Model not yet loaded, using lexical search only. isModelLoaded =', isModelLoaded);
    }

    // Combine lexical and semantic results
    const allIds = new Set([
      ...Object.keys(lexicalScores).map(id => parseInt(id)),
      ...Object.keys(semanticScores).map(id => parseInt(id))
    ]);

    const allResults = Array.from(allIds).map(id => {
      const lexicalScore = lexicalScores[id] || 0;
      const semanticScore = semanticScores[id] || 0;

      // Weight lexical search higher for exact matches
      const totalScore = lexicalScore * 0.6 + semanticScore * 0.4;

      return {
        id,
        semanticScore,
        textScore: lexicalScore,
        totalScore
      };
    });

    const sortedResults = allResults
      .sort((a, b) => {
        // Primary sort: Items with lexical matches come first
        const aHasLexical = a.textScore > 0;
        const bHasLexical = b.textScore > 0;

        if (aHasLexical && !bHasLexical) return -1;
        if (!aHasLexical && bHasLexical) return 1;

        // Secondary sort: Within each group, sort by semantic similarity (descending)
        return b.semanticScore - a.semanticScore;
      });

    const resultIndexes = sortedResults.map(r => r.id);

    const message: SearchWorkerMessage = {
      command: 'finishQuery',
      payload: {
        queryID,
        resultIndexes,
        scores: sortedResults
      }
    };
    postMessage(message);
  } catch (error) {
    console.error('Error in search:', error);
    // Return empty results on error
    const message: SearchWorkerMessage = {
      command: 'finishQuery',
      payload: {
        queryID,
        resultIndexes: [],
        scores: []
      }
    };
    postMessage(message);
  }
};