import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useUndoStack } from "./undoStack";

interface TestEntry {
  label: string;
}

describe("useUndoStack", () => {
  it("starts with no current entry", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());
    expect(result.current.current).toBeNull();
  });

  it("push sets current to the pushed entry", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());
    act(() => result.current.push({ label: "first" }));
    expect(result.current.current).toEqual({ label: "first" });
  });

  it("a new push overwrites the previous entry (single-level, not a history)", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());
    act(() => result.current.push({ label: "first" }));
    act(() => result.current.push({ label: "second" }));
    expect(result.current.current).toEqual({ label: "second" });
  });

  it("consume returns the entry and clears current", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());
    act(() => result.current.push({ label: "first" }));

    let consumed: TestEntry | null = null;
    act(() => {
      consumed = result.current.consume();
    });

    expect(consumed).toEqual({ label: "first" });
    expect(result.current.current).toBeNull();
  });

  it("consume returns null when the stack is empty", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());

    let consumed: TestEntry | null = { label: "unset" };
    act(() => {
      consumed = result.current.consume();
    });

    expect(consumed).toBeNull();
  });

  it("clear empties the stack without returning anything", () => {
    const { result } = renderHook(() => useUndoStack<TestEntry>());
    act(() => result.current.push({ label: "first" }));
    act(() => result.current.clear());

    expect(result.current.current).toBeNull();
  });

  it("works with a differently-shaped entry type in the same file's other instantiations (genericity)", () => {
    interface OtherEntry {
      sessionId: number;
    }
    const { result } = renderHook(() => useUndoStack<OtherEntry>());
    act(() => result.current.push({ sessionId: 42 }));
    expect(result.current.current).toEqual({ sessionId: 42 });
  });
});
