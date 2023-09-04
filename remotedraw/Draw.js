// @flow
import styled from 'styled-components';
import * as React from 'react';

const Wrapper = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
  user-select: none;
`;

const SVGCanvas = styled.svg`
  touch-action: none;
  width: 100%;
  height: 100%;
`;

/**
 * Todo
 *
 * returns {todo}
 */
export default function Draw() {
    const rSoak = React.useRef(null);

    const events = [];

    //   const ref = useSvgResizer();

    //   const marks = useSelector(state => state.data.marks);
    //   const currentMark = useSelector(state => state.data.currentMark)
    //   const showTrace = useSelector(state => state.data.settings.showTrace)
    //   const darkMode = useSelector(state => state.data.settings.darkMode)
    //   const penMode = useSelector(state => state.data.settings.penMode)

    React.useEffect(() => {
        /**
         * Todo
         *
         * returns {todo}
         */
        function preventDefault(e: TouchEvent) {
            e.preventDefault();
        }

        if (rSoak.current && penMode) {
            rSoak.current.addEventListener('gesturestart', preventDefault, false);
            rSoak.current.addEventListener('gestureend', preventDefault, false);
            rSoak.current.addEventListener('gesturechange', preventDefault, false);
            rSoak.current.addEventListener('touchmove', preventDefault, false);
            rSoak.current.addEventListener('touchstart', preventDefault, false);
            rSoak.current.addEventListener('touchend', preventDefault, false);
            rSoak.current.addEventListener('touchcancel', preventDefault, false);
        }

        return () => {
            if (rSoak.current) {
                rSoak.current.removeEventListener('gesturestart', preventDefault, false);
                rSoak.current.removeEventListener('gestureend', preventDefault, false);
                rSoak.current.removeEventListener(
          'gesturechange',
          preventDefault,
          false
                );
                rSoak.current.removeEventListener('touchmove', preventDefault, false);
                rSoak.current.removeEventListener('touchstart', preventDefault, false);
                rSoak.current.removeEventListener('touchend', preventDefault, false);
                rSoak.current.removeEventListener('touchcancel', preventDefault, false);
            }
        };
    }, [ penMode ]);

    return (
        <React.Fragment>
            <main>
                <Wrapper ref={rSoak} {...events}>
                    <SVGCanvas
                        ref={ref}
                        viewBox={'0 0 800 600'}
                        id="drawable-svg"
                        pointerEvents="none"
                    >
                        <g
                            strokeWidth={0}
                            stroke='#000'
                            fill='#000'
                        >
                            {/* {marks.map((mark, i) => (
                <MarkPath key={mark.id} mark={mark} />
              ))}
              {currentMark && <MarkPath mark={currentMark} />} */}
                        </g>
                    </SVGCanvas>
                </Wrapper>
            </main>
        </React.Fragment>
    );
}
