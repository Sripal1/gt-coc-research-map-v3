import type { Writable } from 'svelte/store';
import type { SearchBarStoreValue } from '../../stores';
import { getSearchBarStoreDefaultValue } from '../../stores';
import type { PromptPoint, SearchResult } from '../../types/embedding-types';

export class SearchPanel {
  component: HTMLElement;
  SearchPanelUpdated: () => void;
  inputElement: HTMLInputElement;

  searchBarStore: Writable<SearchBarStoreValue>;
  searchBarStoreValue: SearchBarStoreValue;

  formattedResults: SearchResult[] = [];
  handledQueryID = 0;
  selectedPointId: number | null = null;
  private debounceTimer: number | null = null;
  private readonly DEBOUNCE_DELAY = 100; // ms

  constructor(
    component: HTMLElement,
    SearchPanelUpdated: () => void,
    searchBarStore: Writable<SearchBarStoreValue>
  ) {
    this.component = component;
    this.SearchPanelUpdated = SearchPanelUpdated;

    // Set up the store
    this.searchBarStore = searchBarStore;
    this.searchBarStoreValue = getSearchBarStoreDefaultValue();

    this.inputElement = component.querySelector(
      '#search-bar-input'
    ) as HTMLInputElement;

    this.initStore();
  }

  initStore = () => {
    this.searchBarStore.subscribe(value => {
      this.searchBarStoreValue = value;

      this.handledQueryID = this.searchBarStoreValue.queryID;
      this.formattedResults = this.formatResults(
        this.searchBarStoreValue.results
      );
      this.SearchPanelUpdated();
    });
  };

  /**
   * Format the search results to highlight matches
   * @param results Current search results
   */
  formatResults = (results: PromptPoint[]) => {

    // console.log('Formatting results:', results);
    const formattedResults: SearchResult[] = [];
    const query = this.searchBarStoreValue.query;
    const scores = this.searchBarStoreValue.scores || [];
    // console.log(scores)
    // console.log(results)
    //replace any punctation in the search words first before splitting the query
    const cleanedQuery = query.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
    // console.log(results)
    for (const resultPoint of results) {
      // Try to avoid XSS attack
      const result = resultPoint.prompt;
      if (result.includes('iframe')) continue;
      if (result.includes('<script')) continue;

      const searchWords = new Set(cleanedQuery.split(/\s+/));
      // Find matching score for this point
      const scoreInfo = scores.find(s => s.id === resultPoint.id);

      const newResult: SearchResult = {
        fullText: result,
        shortText: result,
        isSummary: false,
        point: resultPoint,
        isSelected: this.selectedPointId === resultPoint.id,
        scores: {
          semanticScore: scoreInfo?.semanticScore || 0,
          textScore: scoreInfo?.textScore || 0
        }
      };

      newResult.fullText = result;

      // Highlight matching words for lexical search
      for (const word of searchWords) {
        if (word === '') continue;
        const re = new RegExp('\\b' + word + '\\b', 'ig');
        newResult.fullText = newResult.fullText.replaceAll(
          re,
          `<em>${word}</em>`
        );
      }

      // Truncate the text if it is too long
      if (newResult.fullText.length > 300) {
        newResult.shortText = newResult.fullText.slice(0, 300);
        newResult.shortText = newResult.shortText.slice(
          0,
          newResult.shortText.lastIndexOf(' ')
        );
        newResult.shortText = newResult.shortText.concat('...');
      } else {
        newResult.shortText = newResult.fullText;
      }

      formattedResults.push(newResult);
    }

    return formattedResults;
  };

  /**
   * Event handler for event change
   * @param e Event
   */
  inputChanged = (e: InputEvent) => {
    e.preventDefault();

    const query = this.inputElement.value;

    if (query === '') {
      // Cancel immediately — no need to debounce clearing
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.cancelSearch();
      return;
    }

    // Debounce the search query
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (query !== this.searchBarStoreValue.query) {
        this.searchBarStoreValue.query = query;
        this.searchBarStoreValue.queryID += 1;
        this.searchBarStore.set(this.searchBarStoreValue);
      }
    }, this.DEBOUNCE_DELAY);
  };

  /**
   * Collapse the search list
   */
  cancelSearch = () => {
    this.formattedResults = [];
    this.searchBarStoreValue.query = '';
    this.searchBarStoreValue.shown = false;
    this.searchBarStore.set(this.searchBarStoreValue);
  };

  mouseenterHandler = (point: PromptPoint) => {
    this.searchBarStoreValue.highlightSearchPoint(point);
  };

  clickHandler = (point: PromptPoint) => {
    // Check if clicking the same point to unselect and zoom out
    if (this.selectedPointId === point.id) {
      // Unselect and zoom out to full map view
      this.selectedPointId = null;
      this.refreshResults();
      this.searchBarStoreValue.selectSearchPoint(undefined, undefined, true); // true = zoom out flag
    } else {
      // Select new point: update selection and trigger smart zoom
      const oldSelectedPoint = this.getSelectedPoint();
      this.selectedPointId = point.id;
      this.refreshResults();
      this.searchBarStoreValue.selectSearchPoint(point, oldSelectedPoint);
    }
  };

  /**
   * Get the currently selected point object
   */
  private getSelectedPoint = (): PromptPoint | null => {
    if (!this.selectedPointId) return null;
    return this.searchBarStoreValue.results.find(p => p.id === this.selectedPointId) || null;
  };

  /**
   * Refresh the formatted results to update selection states
   */
  private refreshResults = () => {
    this.formattedResults = this.formatResults(this.searchBarStoreValue.results);
    this.SearchPanelUpdated();
  };
}
