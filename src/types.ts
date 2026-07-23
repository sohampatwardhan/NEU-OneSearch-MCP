export interface SearchOneSearchParams {
  query: string;
  limit?: number;
  resourceType?:
    | 'articles'
    | 'journals'
    | 'books'
    | 'newspaper_articles'
    | 'reviews'
    | 'book_chapters'
    | 'dissertations';
  dateFrom?: number;
  dateTo?: number;
  peerReviewedOnly?: boolean;
  sort?: 'rank' | 'date' | 'title' | 'author';
  campus?: 'all' | 'boston' | 'oakland' | 'online';
}

export interface MappedResult {
  recordId: string;
  title: string;
  authors: string[];
  type: string | null;
  date: string | null;
  publisher: string | null;
  isbn: string[];
  issn: string[];
  doi: string | null;
  description: string | null;
  contents: string | null;
  availability: string | null;
  fullTextUrl: string | null;
  catalogUrl: string;
}

export interface SearchOneSearchResult {
  totalResults: number;
  results: MappedResult[];
}

export interface PrimoLink {
  linkType: string;
  linkURL: string;
  displayLabel?: string;
}

export interface PrimoDelivery {
  displayedAvailability?: string | null;
  link?: PrimoLink[] | null;
}

export interface PrimoDisplay {
  title?: string[];
  creator?: string[];
  type?: string[];
  creationdate?: string[];
  publisher?: string[];
  description?: string[];
  contents?: string[];
}

export interface PrimoControl {
  recordid?: string[];
}

export interface PrimoAddata {
  au?: string[];
  isbn?: string[];
  issn?: string[];
  doi?: string[];
}

export interface PrimoDoc {
  pnx: {
    display?: PrimoDisplay;
    control?: PrimoControl;
    addata?: PrimoAddata;
  };
  delivery?: PrimoDelivery;
}

export interface PrimoSearchResponse {
  info: { total: number };
  docs: PrimoDoc[];
}
