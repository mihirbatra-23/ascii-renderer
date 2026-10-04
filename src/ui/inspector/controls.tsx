/**
 * Store-bound dock controls. Each one subscribes to exactly one parameter, so dragging a slider
 * re-renders that row and nothing else. Live values go in with `commit: false`; the end of the
 * gesture (pointer up, Enter, key up) closes them into one undo entry.
 *
 *   <ParamSlider param="contrast" label="Contrast" />
 *   <ParamSwitch param="invert" label="Invert" kbd="I" />
 *   <LabelledRow label="Output fps">{(id) => <Segmented labelledBy={id} … />}</LabelledRow>
 */
import { useId, useState, type ReactNode } from 'react';
import type { RenderParams } from '../../engine/types';
import { defaultParams, NUMERIC_SPECS, type NumericParamKey, type ParamKey } from '../../state/params';
import { useStore } from '../../state/store';
import { SliderRow, SwitchRow } from '../kit';

type BooleanParamKey = { [K in ParamKey]: RenderParams[K] extends boolean ? K : never }[ParamKey];

const DEFAULTS = defaultParams();

export const store = () => useStore.getState();

export function setLive<K extends ParamKey>(key: K, value: RenderParams[K]): void {
  store().setParam(key, value, { commit: false });
}

export function commitLive(): void {
  store().commitParams();
}

export function ParamSlider({ param, label, disabled }: { param: NumericParamKey; label: string; disabled?: boolean }) {
  const value = useStore((s) => s.params[param]);
  const defaultValue = DEFAULTS[param];
  const { min, max, step, bipolar, format } = NUMERIC_SPECS[param];
  return (
    <SliderRow
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      bipolar={bipolar}
      format={format}
      defaultValue={defaultValue}
      disabled={disabled}
      onChange={(v) => setLive(param, v)}
      onCommit={commitLive}
    />
  );
}

export interface ParamSwitchProps {
  param: BooleanParamKey;
  label: string;
  kbd?: string;
  sub?: ReactNode;
}

export function ParamSwitch({ param, label, kbd, sub }: ParamSwitchProps) {
  const checked = useStore((s) => s.params[param]);
  return <SwitchRow label={label} kbd={kbd} sub={sub} checked={checked} onChange={(v) => store().setParam(param, v)} />;
}

/** The 96 px label column of the slider rows, for a segmented control or select on the right. */
export function LabelledRow({ label, children }: { label: string; children(labelId: string): ReactNode }) {
  const id = useId();
  return (
    <div className="segrow">
      <span id={id}>{label}</span>
      {children(id)}
    </div>
  );
}

// Open / closed state of the dock's disclosures outlives the panel (it unmounts while Export is open).
const remembered: Record<string, boolean> = {};

export function useRememberedOpen(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => remembered[id] ?? false);
  return [
    open,
    (next) => {
      remembered[id] = next;
      setOpen(next);
    },
  ];
}
