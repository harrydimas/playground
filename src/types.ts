export interface SectionRow {
  section: string;
  name: string;
}

export interface HarmonizedRow {
  section: string;
  hscode: string;
  description: string;
  parent: string;
  level: number;
}

export interface BpsRow {
  no: number;
  hs_code: string;
  description: string;
}

export interface SectionResult {
  section: string;
  name: string;
  score: number;
}

export interface HSCodeResult {
  hscode: string;
  description: string;
  score: number;
}

export interface DetailResult {
  hs_code: string;
  description: string;
}

export interface EnrichedQuery {
  original: string;
  translated: string;
  /** HS code master's explanation of the product category */
  explanation: string;
  /** Suggested HS heading codes (4-digit) based on LLM knowledge */
  suggestedCodes: string[];
  /** Alternative search terms / synonyms for this product */
  synonyms: string[];
}

export interface SearchResponse {
  original_query: string;
  enriched_query: EnrichedQuery;
  sections: string[];
  hs_codes: HSCodeResult[];
  details: DetailResult[];
}
