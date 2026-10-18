/**
 * The four boxes of the value matrix. The page works this out too, because
 * a coordinator drags the lines and needs the boxes to follow live; this copy
 * is for what the server stores - the daily snapshot - using the saved lines.
 */
export type MatrixBox = 'doNext' | 'plan' | 'fitIn' | 'question';

export const MATRIX_BOXES: MatrixBox[] = ['doNext', 'plan', 'fitIn', 'question'];

export function matrixBox(businessScore: number, effort: number, valueSplit: number, effortSplit: number): MatrixBox {
  const high = businessScore >= valueSplit;
  const heavy = effort >= effortSplit;
  if (high) return heavy ? 'plan' : 'doNext';
  return heavy ? 'question' : 'fitIn';
}

export const REVIEW_OUTCOMES = ['REQUESTED', 'KEPT', 'RESCORE', 'CLOSED'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
