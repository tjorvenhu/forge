import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** changing this value resets the boundary, e.g. when the user navigates elsewhere */
  resetKey?: unknown;
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: string | null;
}

/** Keeps a crash in one view from blanking the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info: info.componentStack ?? null });
    console.error("[forge] render error", error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, info: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6" role="alert">
        <AlertTriangle className="h-6 w-6 text-danger" />
        <div className="text-sm font-medium">Diese Ansicht ist abgestürzt.</div>
        <pre className="max-h-64 max-w-3xl overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 font-mono text-xs text-muted">
          {this.state.error.message}
          {this.state.info ? `\n${this.state.info.trim().split("\n").slice(0, 8).join("\n")}` : ""}
        </pre>
        <Button
          variant="primary"
          onClick={() => {
            this.props.onReset?.();
            this.setState({ error: null, info: null });
          }}
        >
          <RotateCw className="h-3.5 w-3.5" /> Erneut versuchen
        </Button>
      </div>
    );
  }
}
