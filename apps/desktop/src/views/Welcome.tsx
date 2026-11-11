import { ArrowRight, Box, KeyRound, SquareTerminal } from "lucide-react";
import { Logo } from "../components/Logo";

export function Welcome({ onAdd }: { onAdd(): void }) {
  return (
    <div className="welcome canvas">
      <div className="welcome-inner">
        <div className="eyebrow">
          <span className="eyebrow-square" /> Kaname desktop
        </div>
        <h1 className="headline">
          Your panels,
          <br />
          <span className="gradient-text">one window away.</span>
        </h1>
        <p className="lede">
          Keep every Kaname panel you run in one place. Browse the fleet, restart a service, follow the job,
          and drop into a shell — all through the panel’s own API, never around it.
        </p>
        <button className="btn btn-primary btn-lg" onClick={onAdd} autoFocus>
          Add your first Kaname panel <ArrowRight size={15} />
        </button>
        <ul className="welcome-points">
          <li>
            <KeyRound size={14} /> Credentials stay in your OS keychain.
          </li>
          <li>
            <SquareTerminal size={14} /> Terminals use the panel’s audited sessions.
          </li>
          <li>
            <Box size={14} /> Services, containers and jobs, one tab per panel.
          </li>
        </ul>
      </div>
      <div className="welcome-mark" aria-hidden>
        <Logo size={220} />
      </div>
    </div>
  );
}

export function NothingOpen({ onAdd }: { onAdd(): void }) {
  return (
    <div className="empty-main canvas">
      <div className="empty-card">
        <div className="label">No tab open</div>
        <p>Pick a connection on the left to open its fleet, or add another panel.</p>
        <button className="btn btn-ghost" onClick={onAdd}>
          Add a panel
        </button>
      </div>
    </div>
  );
}
