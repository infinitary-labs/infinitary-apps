/**
 * @startingPoint section="Character" subtitle="Quiet crew overview: n working · n idle" viewport="700x120"
 */
export interface CrewStripProps {
  /** Zero counts are omitted; renders null when both are 0. One representative crewmate glyph prefixes each label. Chrome (bg + border) appears on hover only. */
  working?: number;
  idle?: number;
  style?: React.CSSProperties;
}
