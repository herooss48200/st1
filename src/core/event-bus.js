import { EventEmitter } from 'events';
import logger from '../services/logger.js';

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.maxListeners = 100;
    this.setMaxListeners(this.maxListeners);
  }

  emit(eventName, data) {
    logger.info('Event emitted', { event: eventName });
    return super.emit(eventName, data);
  }

  on(eventName, handler) {
    logger.info('Event listener registered', { event: eventName });
    return super.on(eventName, handler);
  }

  once(eventName, handler) {
    logger.info('One-time event listener registered', { event: eventName });
    return super.once(eventName, handler);
  }

  off(eventName, handler) {
    logger.info('Event listener removed', { event: eventName });
    return super.off(eventName, handler);
  }
}

export { EventBus };
export default new EventBus();
