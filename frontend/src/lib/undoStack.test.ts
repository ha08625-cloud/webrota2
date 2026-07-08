import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useUndoStack } from "./undoStack";

describe("useUndoStack", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useUndoStack());
    expect(result.current.current).toBeNull();
  });

  it("push sets the current entry", () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
    });
    expect(result.current.current).toEqual({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
  });

  it("a new push overwrites the previous entry (single-level only)", () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
    });
    act(() => {
      result.current.push({ kind: "swap-rooms", sessionAId: 3, sessionBId: 4 });
    });
    expect(result.current.current).toEqual({ kind: "swap-rooms", sessionAId: 3, sessionBId: 4 });
  });

  it("consume returns the entry and clears it", () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
    });

    let consumed;
    act(() => {
      consumed = result.current.consume();
    });

    expect(consumed).toEqual({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
    expect(result.current.current).toBeNull();
  });

  it("consume on an empty stack returns null", () => {
    const { result } = renderHook(() => useUndoStack());
    let consumed;
    act(() => {
      consumed = result.current.consume();
    });
    expect(consumed).toBeNull();
  });

  it("clear empties the stack without returning the entry", () => {
    const { result } = renderHook(() => useUndoStack());
    act(() => {
      result.current.push({ kind: "swap-roles", sessionAId: 1, sessionBId: 2 });
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.current).toBeNull();
  });
});