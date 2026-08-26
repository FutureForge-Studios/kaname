import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, type ConfirmDialogProps } from "./Dialog.js";

/* ------------------------------------------------------------------ *
 * ConfirmDialog is the last thing between an operator and a destroyed
 * mailbox, database or server (KD-008: the click becomes a job that
 * nothing walks back). Two promises therefore have to hold exactly:
 * the action stays disabled until the typed string matches, and getting
 * out of the dialog never counts as confirming.
 * ------------------------------------------------------------------ */

const SERVER = "web-01";

function setup(overrides: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const props: ConfirmDialogProps = {
    open: true,
    onOpenChange,
    title: "Revoke web-01",
    description: "The agent's certificate is invalidated immediately.",
    confirmText: SERVER,
    confirmLabel: "Revoke server",
    onConfirm,
    ...overrides,
  };

  const view = render(<ConfirmDialog {...props} />);
  return {
    ...view,
    user: userEvent.setup(),
    onConfirm,
    onOpenChange,
    confirm: () => screen.getByRole<HTMLButtonElement>("button", { name: "Revoke server" }),
    field: () => screen.getByLabelText<HTMLInputElement>(/to confirm/),
  };
}

describe("ConfirmDialog", () => {
  it("keeps the action disabled until the exact string is typed", async () => {
    const { user, confirm, field } = setup();

    expect(confirm().disabled).toBe(true);

    await user.type(field(), "web-0");
    expect(confirm().disabled).toBe(true);

    await user.type(field(), "1");
    expect(confirm().disabled).toBe(false);

    await user.type(field(), "2");
    expect(confirm().disabled).toBe(true);
  });

  it("does not accept a near miss", async () => {
    const { user, confirm, field } = setup();

    await user.type(field(), "WEB-01");
    expect(confirm().disabled).toBe(true);

    await user.clear(field());
    await user.type(field(), "web-1");
    expect(confirm().disabled).toBe(true);

    await user.clear(field());
    await user.type(field(), "  web-01  ");
    expect(confirm().disabled).toBe(false);
  });

  it("confirms once, and leaves closing to the caller", async () => {
    const { user, confirm, field, onConfirm, onOpenChange } = setup();

    await user.type(field(), SERVER);
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The job is created by the caller; the dialog stays put until told.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape without confirming", async () => {
    const { user, field, onConfirm, onOpenChange } = setup();

    await user.type(field(), SERVER);
    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels without confirming", async () => {
    const { user, onConfirm, onOpenChange } = setup();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("pins itself while the job is being created", async () => {
    const { user, onOpenChange } = setup({ loading: true });

    await user.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  });

  it("arms immediately when no typed confirmation is demanded", () => {
    const { confirm } = setup({ confirmText: undefined });

    expect(confirm().disabled).toBe(false);
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
  });

  it("forgets what was typed when it is reopened", async () => {
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Revoke web-01"
            confirmText={SERVER}
            confirmLabel="Revoke server"
            onConfirm={() => {}}
          />
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText(/to confirm/), SERVER);
    const confirm = () => screen.getByRole<HTMLButtonElement>("button", { name: "Revoke server" });
    expect(confirm().disabled).toBe(false);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByLabelText<HTMLInputElement>(/to confirm/).value).toBe("");
    expect(confirm().disabled).toBe(true);
  });

  it("dresses a destructive action in danger, and a benign one in the accent", () => {
    const { confirm, unmount } = setup();
    expect(confirm().className).toContain("bg-[var(--kn-danger)]");
    unmount();

    const benign = setup({ destructive: false });
    expect(benign.confirm().className).toContain("bg-[var(--kn-accent-600)]");
  });

  it("focuses the confirmation field so the operator can type straight away", () => {
    const { field } = setup();
    expect(document.activeElement).toBe(field());
  });
});
