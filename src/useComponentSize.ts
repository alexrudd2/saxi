/* Copyright (c) 2018-present Fouad Matin <open@fouad.org>
MIT license
https://github.com/rehooks/component-size
Minor edits made to port to TS
*/


import { useCallback, useLayoutEffect, useState } from "react";

interface ComponentSize {
  width: number;
  height: number;
}

function getSize(el: HTMLElement | null): ComponentSize {
  if (!el) {
    return {
      width: 0,
      height: 0,
    };
  }

  return {
    width: el.offsetWidth,
    height: el.offsetHeight,
  };
}

export default function useComponentSize<T extends HTMLElement = HTMLElement>(ref: React.RefObject<T>): ComponentSize {
  const [componentSize, setComponentSize] = useState<ComponentSize>(getSize(ref ? ref.current : null));

  const handleResize = useCallback(
    function handleResize() {
      if (ref.current) {
        setComponentSize(getSize(ref.current));
      }
    },
    [ref],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: preserve original library behavior
  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }

    handleResize();

    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(ref.current);

      return () => {
        resizeObserver.disconnect();
      };
    }
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };  }, [ref.current]);

  return componentSize;
}
