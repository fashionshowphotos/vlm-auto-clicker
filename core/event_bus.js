/**
 * Workflow Event Bus
 *
 * Central event aggregation for the AI workforce.
 * Standardized events with history buffer.
 */

import { EventEmitter } from 'events';

export const EVENT_TYPES = {
  WORKFLOW_QUEUED: 'workflow_queued',
  WORKFLOW_STARTED: 'workflow_started',
  WORKFLOW_COMPLETED: 'workflow_completed',
  WORKFLOW_FAILED: 'workflow_failed',
  PHASE_STARTED: 'phase_started',
  PHASE_COMPLETED: 'phase_completed',
  BUDGET_EXCEEDED: 'workflow_budget_exceeded',
  SYSTEM_INFO: 'system_info',
  SYSTEM_WARNING: 'system_warning',
  SYSTEM_ERROR: 'system_error',
  AUTO_CLICK_STATE: 'auto_click_state',
  AUTO_CLICK_DETECTED: 'auto_click_detected',
  AUTO_CLICK_EXECUTED: 'auto_click_executed',
  AUTO_CLICK_LEARN: 'auto_click_learn',
  AUTO_CLICK_CONFIDENCE_DROP: 'auto_click_confidence_drop'
};

export class WorkflowEventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = {
      maxEvents: options.maxEvents ?? 500,
      logToConsole: options.logToConsole ?? true
    };
    this.history = [];
    this.subscribers = new Set();
  }

  publish(type, data = {}) {
    const event = {
      timestamp: Date.now(),
      type,
      workflowId: data.workflowId || null,
      ...data
    };

    this.history.push(event);
    if (this.history.length > this.config.maxEvents) {
      this.history = this.history.slice(-this.config.maxEvents);
    }

    if (this.config.logToConsole) {
      const time = new Date(event.timestamp).toISOString().slice(11, 23);
      const wf = event.workflowId ? `[${event.workflowId}]` : '';
      console.log(`[EventBus] ${time} ${event.type} ${wf}`);
    }

    this.emit('event', event);
    this.emit(type, event);

    for (const callback of this.subscribers) {
      try { callback(event); } catch (err) {
        console.error('[EventBus] Subscriber error:', err.message);
      }
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getRecentEvents(limit = 50) {
    return this.history.slice(-limit).reverse();
  }

  getWorkflowEvents(workflowId, limit = 100) {
    return this.history.filter(e => e.workflowId === workflowId).slice(-limit);
  }

  attachBudgetController(budgetController) {
    budgetController.on('workflow_budget_exceeded', (data) => {
      this.publish(EVENT_TYPES.BUDGET_EXCEEDED, data);
    });
    console.log('[EventBus] Attached budget controller');
  }

  info(message) { this.publish(EVENT_TYPES.SYSTEM_INFO, { message }); }
  warning(message) { this.publish(EVENT_TYPES.SYSTEM_WARNING, { message }); }
  error(message) { this.publish(EVENT_TYPES.SYSTEM_ERROR, { message }); }
}

export const eventBus = new WorkflowEventBus();
export default WorkflowEventBus;
