/** Sepet toplamı (kuruş hassasiyetinde yuvarlanır). */
export function cartTotal(items) {
  return Math.round(items.reduce((sum, i) => sum + i.price * i.qty, 0) * 100) / 100;
}
