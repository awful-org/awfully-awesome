export interface PeerSnapshot {
  did: string;
}

export function createHostDepartureGrace(
  hostDid: string,
  peers: () => PeerSnapshot[],
  close: () => void,
  // Call setup can briefly tear down the relay peer before reconnecting.
  // Keep the original five-second tolerance as the minimum, but allow the
  // negotiation window to complete before declaring the host gone.
  delay = 15_000
) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelWhenHostReturns() {
    if (!timer || !peers().some((peer) => peer.did === hostDid)) return;
    clearTimeout(timer);
    timer = null;
  }

  function observeDisconnect(did: string) {
    if (!hostDid || did !== hostDid || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!peers().some((peer) => peer.did === hostDid)) close();
    }, delay);
  }

  return {
    observeDisconnect,
    observePeers: cancelWhenHostReturns,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
