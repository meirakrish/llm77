// Small amounts need more decimals to be meaningful
export const formatCost = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
