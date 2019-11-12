import hoistStatics from 'hoist-non-react-statics'
import invariant from 'invariant'
import React, {
  useContext,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useReducer
} from 'react'
import { isValidElementType, isContextConsumer } from 'react-is'
import Subscription from '../utils/Subscription'
import shallowEqual from '../utils/shallowEqual'

import { ReactReduxContext } from './Context'

// Define some constant arrays just to avoid re-creating these
const EMPTY_ARRAY = []
const NO_SUBSCRIPTION_ARRAY = [null, null]

function makeSelectorStateful(sourceSelector, store) {
  // wrap the selector in an object that tracks its results between runs.
  const selector = {
    run: function runComponentSelector(props) {
      try {
        const nextProps = sourceSelector(store.getState(), props);
        if (nextProps !== selector.props || selector.error) {
          selector.shouldComponentUpdate = true;
          selector.props = nextProps;
          selector.error = null
        }
      } catch (error) {
        // console.log("error = ", error);
        selector.shouldComponentUpdate = true;
        selector.error = error
      }
    }
  };

  return selector
}

function isValidContext(Ctx) {
  return Ctx && Ctx.Consumer && isContextConsumer(<Ctx.Consumer />)
}

const stringifyComponent = Comp => {
  try {
    return JSON.stringify(Comp)
  } catch (err) {
    return String(Comp)
  }
}

function storeStateUpdatesReducer(state, action) {
  const [, updateCount] = state
  return [action.payload, updateCount + 1]
}

const initStateUpdates = () => [null, 0]

// React currently throws a warning when using useLayoutEffect on the server.
// To get around it, we can conditionally useEffect on the server (no-op) and
// useLayoutEffect in the browser. We need useLayoutEffect because we want
// `connect` to perform sync updates to a ref to save the latest props after
// a render is actually committed to the DOM.
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' &&
  typeof window.document !== 'undefined' &&
  typeof window.document.createElement !== 'undefined'
    ? useLayoutEffect
    : useEffect

export default function connectAdvanced(
  /*
    selectorFactory is a func that is responsible for returning the selector function used to
    compute new props from state, props, and dispatch. For example:

      export default connectAdvanced((dispatch, options) => (state, props) => ({
        thing: state.things[props.thingId],
        saveThing: fields => dispatch(actionCreators.saveThing(props.thingId, fields)),
      }))(YourComponent)

    Access to dispatch is provided to the factory so selectorFactories can bind actionCreators
    outside of their selector as an optimization. Options passed to connectAdvanced are passed to
    the selectorFactory, along with displayName and WrappedComponent, as the second argument.

    Note that selectorFactory is responsible for all caching/memoization of inbound and outbound
    props. Do not use connectAdvanced directly without memoizing results between calls to your
    selector, otherwise the Connect component will re-render on every state or props change.
  */
  selectorFactory,
  // options object:
  {
    // the func used to compute this HOC's displayName from the wrapped component's displayName.
    // probably overridden by wrapper functions such as connect()
    getDisplayName = name => `ConnectAdvanced(${name})`,

    // shown in error messages
    // probably overridden by wrapper functions such as connect()
    methodName = 'connectAdvanced',

    // REMOVED: if defined, the name of the property passed to the wrapped element indicating the number of
    // calls to render. useful for watching in react devtools for unnecessary re-renders.
    renderCountProp = undefined,

    // determines whether this HOC subscribes to store changes
    shouldHandleStateChanges = true,

    // REMOVED: the key of props/context to get the store
    storeKey = 'store',

    // REMOVED: expose the wrapped component via refs
    withRef = false,

    // use React's forwardRef to expose a ref of the wrapped component
    forwardRef = false,

    // the context consumer to use
    context = ReactReduxContext,

    pureComponent = false,

    // additional options are passed through to the selectorFactory
    ...connectOptions
  } = {}
) {
  invariant(
    renderCountProp === undefined,
    `renderCountProp is removed. render counting is built into the latest React Dev Tools profiling extension`
  )

  invariant(
    !withRef,
    'withRef is removed. To access the wrapped instance, use a ref on the connected component'
  )

  const customStoreWarningMessage =
    'To use a custom Redux store for specific components, create a custom React context with ' +
    "React.createContext(), and pass the context object to React Redux's Provider and specific components" +
    ' like: <Provider context={MyContext}><ConnectedComponent context={MyContext} /></Provider>. ' +
    'You may also pass a {context : MyContext} option to connect'

  invariant(
    storeKey === 'store',
    'storeKey has been removed and does not do anything. ' +
    customStoreWarningMessage
  )

  const Context = context

  return function wrapWithConnect(WrappedComponent) {
    if (process.env.NODE_ENV !== 'production') {
      invariant(
        isValidElementType(WrappedComponent),
        `You must pass a component to the function returned by ` +
        `${methodName}. Instead received ${stringifyComponent(
          WrappedComponent
        )}`
      )
    }

    const wrappedComponentName =
      WrappedComponent.displayName || WrappedComponent.name || 'Component'

    const displayName = getDisplayName(wrappedComponentName)

    const selectorFactoryOptions = {
      ...connectOptions,
      getDisplayName,
      methodName,
      renderCountProp,
      shouldHandleStateChanges,
      storeKey,
      displayName,
      wrappedComponentName,
      WrappedComponent
    }

    const { pure } = connectOptions

    function createChildSelector(store) {
      return selectorFactory(store.dispatch, selectorFactoryOptions)
    }

    // If we aren't running in "pure" mode, we don't want to memoize values.
    // To avoid conditionally calling hooks, we fall back to a tiny wrapper
    // that just executes the given callback immediately.
    const usePureOnlyMemo = pure ? useMemo : callback => callback()

    function ConnectFunction(props) {
      const latest = useRef({});
      const [,forceUpdate] = React.useReducer((s,a) => s+1, 0)
      const ContextToUse = (props.context && props.context.Consumer && props.context) || Context
      const context = useContext(ContextToUse)

      const store = props.store || (context && context.store)
      const propsMode = Boolean(props.store)

      const [ChildProvider, selector, subscription] = useMemo(() => {
        invariant(store,
          `Could not find "${storeKey}" in either the context or props of ` +
          `"${displayName}". Either wrap the root component in a <Provider>, ` +
          `or explicitly pass "${storeKey}" as a prop to "${displayName}".`
        )

        let ChildProvider = undefined
        const sourceSelector = selectorFactory(store.dispatch, selectorFactoryOptions)
        const selector = makeSelectorStateful(sourceSelector, store)

        let subscription, notifyNestedSubs
        if(shouldHandleStateChanges) {
          const parentSub = propsMode ? null : context.subscription
          subscription = new Subscription(store, parentSub)
          notifyNestedSubs = subscription.notifyNestedSubs.bind(subscription)
          subscription.onStateChange = function onStateChange() {
            if(latest.current.state === store.getState()) {
              notifyNestedSubs()
              return
            }

            selector.run(latest.current.props);

            if (!selector.shouldComponentUpdate) {
              notifyNestedSubs()
            } else {
              latest.current.notifyNestedSubs = notifyNestedSubs;
              forceUpdate()
            }
          }

          if(!propsMode)
            ChildProvider = React.createElement(ContextToUse.Provider, {value:{store, subscription}})
        }
        return [ChildProvider, selector, subscription]
      }, [store, ContextToUse, propsMode])

      useIsomorphicLayoutEffect(() => {
        if (!shouldHandleStateChanges)
          return;
        subscription.trySubscribe();

        return () => {
          if (subscription)
            subscription.tryUnsubscribe();
        }
      }, [store]);

      useIsomorphicLayoutEffect(() => {
        if(latest.current.notifyNestedSubs) {
          latest.current.notifyNestedSubs()
          latest.current.notifyNestedSubs = null
        }
      })

      if(selector.error) {
        throw selector.error
      }

      let currentStoreState = store.getState();
      if(latest.current.state !== currentStoreState || !shallowEqual(latest.current.props, props) || !pure) {
        selector.run(props)
        if(selector.error) {
          throw selector.error
        }
      }

      if(latest.current.childProps !== selector.props || latest.current.ChildProvider !== ChildProvider) {
        latest.current.ChildProvider = ChildProvider
        latest.current.childProps = selector.props

        latest.current.rendredChild = <WrappedComponent {...addExtraProps(selector.props)}/>
        if(ChildProvider) {
          latest.current.rendredChild = React.cloneElement(ChildProvider,
            {},
            latest.current.rendredChild)
        }

        selector.shouldComponentUpdate = false
      }
      latest.current.props = props
      latest.current.state = currentStoreState

      return latest.current.rendredChild;

      function addExtraProps(props) {
        if (!forwardRef) return props;
        const {forwardedRef, ...withExtras} = props;
        withExtras.ref = forwardedRef;
        return withExtras
      }
    }

    // If we're in "pure" mode, ensure our wrapper component only re-renders when incoming props have changed.
    const Connect = (pure && pureComponent) ? React.memo(ConnectFunction) : ConnectFunction

    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = displayName

    if (forwardRef) {
      const forwarded = React.forwardRef(function forwardConnectRef(
        props,
        ref
      ) {
        return <Connect {...props} forwardedRef={ref} />
      })

      forwarded.displayName = displayName
      forwarded.WrappedComponent = WrappedComponent
      return hoistStatics(forwarded, WrappedComponent)
    }

    return hoistStatics(Connect, WrappedComponent)
  }
}
