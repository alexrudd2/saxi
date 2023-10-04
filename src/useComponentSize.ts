import {
  useLayoutEffect,
  useCallback,
  useState,
  useEffect,
} from "preact/hooks";

function getSize(el) {
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

export interface ComponentSizeData {
  width: number;
  height: number;
}

export default function useComponentSize(ref) {
  const [componentSize, setComponentSize] = useState(
    getSize(ref ? ref.current : {})
  );

  const handleResize = useCallback(() => {
    if (ref.current) {
      setComponentSize(getSize(ref.current));
    }
  }, [ref]);

  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [ref.current]);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const onClicked = () => {
      const prevSize = getSize(ref.current);
      setTimeout(() => {
        const currentSize = getSize(ref.current);
        if (JSON.stringify(currentSize) !== JSON.stringify(prevSize)) {
          handleResize();
        }
      }, 300);
    };
    document.addEventListener("click", onClicked);

    return () => {
      document.removeEventListener("click", onClicked);
    };
  }, [ref.current]);

  return componentSize;
}