type WechatRecord = Record<string, unknown>;

interface WechatPageInstance<D> {
  data: D;
  setData(data: Partial<D> | WechatRecord, callback?: () => void): void;
}

declare function Page<D extends WechatRecord, M extends WechatRecord>(
  options: D extends { data: infer P }
    ? D & M & ThisType<D & M & WechatPageInstance<P>>
    : D & M,
): void;

declare function App<T extends WechatRecord>(
  options: T & ThisType<T & { globalData: WechatRecord }>,
): void;

declare const wx: any;
