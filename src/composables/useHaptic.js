export function useHaptic() {
  const canVibrate = 'vibrate' in navigator

  const tap    = () => canVibrate && navigator.vibrate(10)
  const success = () => canVibrate && navigator.vibrate([30, 20, 60])
  const error   = () => canVibrate && navigator.vibrate([50, 30, 50, 30, 100])
  const levelUp = () => canVibrate && navigator.vibrate([100, 50, 100, 50, 200])
  const coin    = () => canVibrate && navigator.vibrate([20, 10, 20])

  return { tap, success, error, levelUp, coin }
}
