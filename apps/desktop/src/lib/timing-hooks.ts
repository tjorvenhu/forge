import { useEffect, useRef, useState } from "react";

/** The value once it stopped changing for `ms`; for inputs that trigger requests on every keystroke. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The value at most every `ms` (with a trailing update); `ms <= 0` passes it through unchanged. */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    const wait = ms <= 0 ? 0 : last.current + ms - Date.now();
    if (wait <= 0) return show();
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms <= 0 ? value : shown;
}
