(function () {
  function normalize(candidate) {
    if (!candidate) return null;
    if (typeof candidate.create === 'function') return candidate;
    if (typeof candidate.createNewDomofonPlayer === 'function') {
      return {
        create: candidate.createNewDomofonPlayer,
        defineElement: candidate.defineElement || candidate.defineNewDomofonPlayerElement
      };
    }
    return null;
  }

  var candidate = normalize(window.NewDomofonPlayer);

  if (!candidate) {
    try {
      if (typeof NewDomofonPlayer !== 'undefined') candidate = normalize(NewDomofonPlayer);
    } catch (_) {
      candidate = null;
    }
  }

  if (candidate) window.NewDomofonPlayer = candidate;
})();
