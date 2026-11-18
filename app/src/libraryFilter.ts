// The Add connector library by area: in each area the connectors that can be connected come first, then the rest, each
// part from the most used tool to the least. Unless showHidden is on, the ones that cannot be connected are left out;
// an area left with nothing is dropped
export function libraryAreas<T extends { id: string }, A extends { id: string }>(
  list: readonly T[],
  areas: readonly A[],
  { areaOf, ready, rank, showHidden }: { areaOf: (x: T) => string; ready: (x: T) => boolean; rank: (id: string) => number; showHidden: boolean },
): { area: A; items: T[] }[] {
  return areas
    .map((area) => ({ area, items: list.filter((x) => areaOf(x) === area.id && (showHidden || ready(x))).sort((p, q) => Number(ready(q)) - Number(ready(p)) || rank(p.id) - rank(q.id)) }))
    .filter((a) => a.items.length > 0);
}
