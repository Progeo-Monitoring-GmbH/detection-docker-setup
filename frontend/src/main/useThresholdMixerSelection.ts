import { useState } from 'react';
import { rangeBetween } from './thresholdMixer';
import { toggledIn } from './thresholdMixerView';

type Modifiers = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** The mixer's selected sensors, the anchor of a Shift range and the value typed for them. */
const useThresholdMixerSelection = () => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // The value typed for the selection ("Auswahl setzen").
  const [bulkValue, setBulkValue] = useState('');

  /** A click with Shift selects the range from the anchor, with Ctrl/⌘ adds or
   * removes one sensor - true if it did; a plain click selects nothing here. */
  const selectByClick = ({ shiftKey, ctrlKey, metaKey }: Modifiers, order: number, orders: number[]) => {
    if (shiftKey && anchor != null) {
      setSelected((prev) => new Set([...prev, ...rangeBetween(orders, anchor, order)]));
      return true;
    }
    if (ctrlKey || metaKey) {
      setSelected((prev) => toggledIn(prev, order));
      setAnchor(order);
      return true;
    }
    return false;
  };

  return { selected, setSelected, setAnchor, selectByClick, bulkValue, setBulkValue };
};

export default useThresholdMixerSelection;
