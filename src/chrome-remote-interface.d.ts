declare module "chrome-remote-interface" {
  interface DevToolsTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
    devtoolsFrontendUrl?: string;
    [key: string]: any;
  }

  interface DevToolsOptions {
    host?: string;
    port?: number;
    secure?: boolean;
  }

  interface CDPOptions extends DevToolsOptions {
    /** A target id, a target object from List/New, or a function picking one from the list. */
    target?: string | DevToolsTarget | ((targets: DevToolsTarget[]) => DevToolsTarget | number);
    local?: boolean;
  }

  interface CDPClient {
    Page: any;
    Runtime: any;
    DOM: any;
    Accessibility: any;
    Input: any;
    Network: any;
    Target: any;
    Emulation: any;
    webSocketUrl: string;
    on(event: string, cb: (...args: any[]) => void): this;
    once(event: string, cb: (...args: any[]) => void): this;
    off(event: string, cb: (...args: any[]) => void): this;
    removeListener(event: string, cb: (...args: any[]) => void): this;
    close(): Promise<void>;
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options?: DevToolsOptions): Promise<DevToolsTarget[]>;
    function New(options?: DevToolsOptions & { url?: string }): Promise<DevToolsTarget>;
    function Activate(options: DevToolsOptions & { id: string }): Promise<void>;
    function Close(options: DevToolsOptions & { id: string }): Promise<void>;
    function Version(options?: DevToolsOptions): Promise<any>;
  }

  export = CDP;
}
