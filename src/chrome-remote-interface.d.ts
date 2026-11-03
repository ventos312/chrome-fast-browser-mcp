declare module "chrome-remote-interface" {
  interface CDPOptions {
    port?: number;
    host?: string;
    target?: string;
  }

  interface CDPClient {
    Page: any;
    Runtime: any;
    DOM: any;
    Accessibility: any;
    Input: any;
    Network: any;
    target: { id: string };
    on(event: string, cb: (...args: any[]) => void): void;
    close(): Promise<void>;
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options?: { port?: number }): Promise<any[]>;
    function New(options?: { port?: number; url?: string }): Promise<any>;
    function Activate(options?: { port?: number; id: string }): Promise<void>;
    function Close(options?: { port?: number; id: string }): Promise<void>;
  }

  export = CDP;
}
