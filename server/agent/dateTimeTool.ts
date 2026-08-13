import { Temporal } from '@js-temporal/polyfill'
import type { AgentTool, AgentToolExecutionResult } from './types'
import { config } from '../utils/config'

type DateTimeOperation =
    | 'now'
    | 'difference_from_now'
    | 'convert_timezone'
    | 'add_duration'
    | 'difference'
    | 'inspect'
    | 'from_epoch'

type DurationUnit = 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds'

interface DateTimeArguments {
    operation: DateTimeOperation
    dateTime?: string
    timeZone?: string
    targetTime?: string
    dayOffset?: number
    targetTimeZone?: string
    startDateTime?: string
    startTimeZone?: string
    endDateTime?: string
    endTimeZone?: string
    epochValue?: number
    epochUnit?: 'seconds' | 'milliseconds'
    years?: number
    months?: number
    weeks?: number
    days?: number
    hours?: number
    minutes?: number
    seconds?: number
}

const durationUnits: DurationUnit[] = [
    'years',
    'months',
    'weeks',
    'days',
    'hours',
    'minutes',
    'seconds',
]

const durationLimits: Record<DurationUnit, number> = {
    years: 100,
    months: 1200,
    weeks: 5200,
    days: 36_500,
    hours: 1_000_000,
    minutes: 1_000_000,
    seconds: 31_536_000,
}

const dayOfWeekNames = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']

export function createDateTimeTool(
    now: () => Temporal.Instant = () => Temporal.Now.instant(),
    defaultTimeZone?: string
): AgentTool {
    const configuredDefaultTimeZone = defaultTimeZone ? normalizeTimeZone(defaultTimeZone) : undefined
    return {
        definition: {
            name: 'datetime',
            description: [
                '执行可靠的日期时间操作，不得自行猜测时区或夏令时规则。',
                'now：使用 timeZone 查询当前时间。',
                'difference_from_now：使用 targetTime（HH:mm 或 HH:mm:ss）、可选 dayOffset 和 timeZone，计算当前时间到当地目标时刻的精确差值。',
                'convert_timezone：使用 dateTime、可选源 timeZone 和 targetTimeZone 转换时区。',
                'add_duration：使用 dateTime、可选 timeZone 和一个或多个时长字段进行日历加减。',
                'difference：使用 startDateTime/endDateTime 及其可选时区计算精确时间差。',
                'inspect：使用 dateTime 和可选 timeZone 查询星期、闰年、年内天数等属性。',
                'from_epoch：使用 epochValue、epochUnit 和可选 timeZone 转换 Unix 时间戳。',
                configuredDefaultTimeZone
                    ? `无 Z、UTC offset 或 IANA 时区的本地时间直接使用后端默认时区 ${configuredDefaultTimeZone}，不要要求用户重复提供。`
                    : '无 Z 或 UTC offset 的本地时间必须提供对应 IANA 时区，例如 Asia/Shanghai。',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    operation: {
                        type: 'string',
                        enum: ['now', 'difference_from_now', 'convert_timezone', 'add_duration', 'difference', 'inspect', 'from_epoch'],
                        description: '需要执行的日期时间操作。',
                    },
                    dateTime: {
                        type: 'string',
                        description: 'ISO 8601 时间。无 Z 或 offset 时必须同时提供 timeZone。',
                    },
                    timeZone: {
                        type: 'string',
                        description: 'IANA 时区，例如 Asia/Shanghai；now、difference_from_now、add_duration、inspect、from_epoch 使用。',
                    },
                    targetTime: {
                        type: 'string',
                        description: 'difference_from_now 的当地目标时刻，严格使用 HH:mm 或 HH:mm:ss。',
                    },
                    dayOffset: {
                        type: 'integer',
                        description: 'difference_from_now 的目标日期偏移；0 表示今天，1 表示明天，-1 表示昨天，默认 0。',
                    },
                    targetTimeZone: {
                        type: 'string',
                        description: 'convert_timezone 的目标 IANA 时区。',
                    },
                    startDateTime: {
                        type: 'string',
                        description: 'difference 的开始 ISO 8601 时间。',
                    },
                    startTimeZone: {
                        type: 'string',
                        description: '开始时间没有 Z 或 offset 时使用的 IANA 时区。',
                    },
                    endDateTime: {
                        type: 'string',
                        description: 'difference 的结束 ISO 8601 时间。',
                    },
                    endTimeZone: {
                        type: 'string',
                        description: '结束时间没有 Z 或 offset 时使用的 IANA 时区。',
                    },
                    epochValue: {
                        type: 'integer',
                        description: 'from_epoch 使用的 Unix 时间戳数值。',
                    },
                    epochUnit: {
                        type: 'string',
                        enum: ['seconds', 'milliseconds'],
                        description: 'Unix 时间戳单位。',
                    },
                    years: { type: 'integer', description: 'add_duration 使用的年数，可为负数。' },
                    months: { type: 'integer', description: 'add_duration 使用的月数，可为负数。' },
                    weeks: { type: 'integer', description: 'add_duration 使用的周数，可为负数。' },
                    days: { type: 'integer', description: 'add_duration 使用的日历天数，可为负数。' },
                    hours: { type: 'integer', description: 'add_duration 使用的小时数，可为负数。' },
                    minutes: { type: 'integer', description: 'add_duration 使用的分钟数，可为负数。' },
                    seconds: { type: 'integer', description: 'add_duration 使用的秒数，可为负数。' },
                },
                required: ['operation'],
                additionalProperties: false,
            },
        },

        async execute(argumentsValue, signal) {
            throwIfAborted(signal)
            try {
                const result = executeOperation(
                    argumentsValue as unknown as DateTimeArguments,
                    now,
                    configuredDefaultTimeZone
                )
                throwIfAborted(signal)
                return { content: JSON.stringify(result), isError: false }
            } catch (error) {
                throwIfAborted(signal)
                if (error instanceof DateTimeInputError) return toolInputError(error.message)
                if (error instanceof RangeError) {
                    return toolInputError('日期时间、时区或计算结果无效，请检查 ISO 8601 输入和 IANA 时区。')
                }
                throw error
            }
        },
    }
}

export const dateTimeTool = createDateTimeTool(
    () => Temporal.Now.instant(),
    config.agentDefaultTimeZone
)

function executeOperation(
    input: DateTimeArguments,
    now: () => Temporal.Instant,
    defaultTimeZone?: string
): Record<string, unknown> {
    switch (input.operation) {
        case 'now': {
            const timeZone = normalizeTimeZone(input.timeZone ?? defaultTimeZone ?? 'UTC')
            return {
                operation: input.operation,
                result: snapshot(now().toZonedDateTimeISO(timeZone)),
            }
        }
        case 'difference_from_now': {
            const timeZone = normalizeTimeZone(input.timeZone ?? defaultTimeZone ?? 'UTC')
            const current = now().toZonedDateTimeISO(timeZone)
            const targetTime = parseTimeOfDay(requiredText(
                input.targetTime,
                'difference_from_now 需要 targetTime，例如 17:30。'
            ))
            const dayOffset = input.dayOffset ?? 0
            if (!Number.isSafeInteger(dayOffset) || Math.abs(dayOffset) > 366) {
                throw new DateTimeInputError('difference_from_now 的 dayOffset 必须是 -366 到 366 之间的整数。')
            }
            const target = current.toPlainDate()
                .add({ days: dayOffset })
                .toPlainDateTime(targetTime)
                .toZonedDateTime(timeZone, { disambiguation: 'reject' })
            return differenceResult(input.operation, current, target, { targetTime: input.targetTime, dayOffset })
        }
        case 'convert_timezone': {
            const dateTime = requiredText(input.dateTime, 'convert_timezone 需要 dateTime。')
            const targetTimeZone = normalizeTimeZone(requiredText(
                input.targetTimeZone,
                'convert_timezone 需要 targetTimeZone。'
            ))
            const source = parseZonedDateTime(dateTime, input.timeZone, defaultTimeZone)
            return {
                operation: input.operation,
                source: snapshot(source),
                result: snapshot(source.toInstant().toZonedDateTimeISO(targetTimeZone)),
            }
        }
        case 'add_duration': {
            const dateTime = requiredText(input.dateTime, 'add_duration 需要 dateTime。')
            const source = parseZonedDateTime(dateTime, input.timeZone, defaultTimeZone)
            const duration = readDuration(input)
            return {
                operation: input.operation,
                source: snapshot(source),
                duration,
                result: snapshot(source.add(duration, { overflow: 'reject' })),
            }
        }
        case 'difference': {
            const start = parseZonedDateTime(
                requiredText(input.startDateTime, 'difference 需要 startDateTime。'),
                input.startTimeZone,
                defaultTimeZone
            )
            const end = parseZonedDateTime(
                requiredText(input.endDateTime, 'difference 需要 endDateTime。'),
                input.endTimeZone,
                defaultTimeZone
            )
            return differenceResult(input.operation, start, end)
        }
        case 'inspect': {
            const dateTime = requiredText(input.dateTime, 'inspect 需要 dateTime。')
            return {
                operation: input.operation,
                result: snapshot(parseZonedDateTime(dateTime, input.timeZone, defaultTimeZone)),
            }
        }
        case 'from_epoch': {
            const epochValue = input.epochValue
            if (typeof epochValue !== 'number' || !Number.isSafeInteger(epochValue)) {
                throw new DateTimeInputError('from_epoch 需要安全整数 epochValue。')
            }
            if (input.epochUnit !== 'seconds' && input.epochUnit !== 'milliseconds') {
                throw new DateTimeInputError('from_epoch 需要 epochUnit：seconds 或 milliseconds。')
            }
            const epochMilliseconds = input.epochUnit === 'seconds'
                ? epochValue * 1000
                : epochValue
            if (!Number.isSafeInteger(epochMilliseconds)) {
                throw new DateTimeInputError('Unix 时间戳超出安全整数范围。')
            }
            const timeZone = normalizeTimeZone(input.timeZone ?? defaultTimeZone ?? 'UTC')
            return {
                operation: input.operation,
                epochValue,
                epochUnit: input.epochUnit,
                result: snapshot(Temporal.Instant.fromEpochMilliseconds(epochMilliseconds).toZonedDateTimeISO(timeZone)),
            }
        }
        default:
            throw new DateTimeInputError('不支持当前日期时间操作。')
    }
}

function parseZonedDateTime(
    value: string,
    requestedTimeZone?: string,
    defaultTimeZone?: string
): Temporal.ZonedDateTime {
    const dateTime = requiredText(value, '日期时间不能为空。')
    if (dateTime.length > 100) throw new DateTimeInputError('日期时间长度不能超过 100 个字符。')
    const timeZone = requestedTimeZone ? normalizeTimeZone(requestedTimeZone) : undefined

    try {
        const zoned = Temporal.ZonedDateTime.from(dateTime, { disambiguation: 'reject', offset: 'reject' })
        return timeZone ? zoned.toInstant().toZonedDateTimeISO(timeZone) : zoned
    } catch {
        // Continue with offset/UTC or local ISO parsing.
    }

    if (dateTime.includes('[') || dateTime.includes(']')) {
        throw new DateTimeInputError('带 IANA 时区标注的日期时间无效，或 UTC offset 与时区规则不一致。')
    }

    try {
        const instant = Temporal.Instant.from(dateTime)
        return instant.toZonedDateTimeISO(timeZone ?? 'UTC')
    } catch {
        // A local date-time requires an explicit IANA time zone.
    }

    const localTimeZone = timeZone ?? defaultTimeZone
    if (!localTimeZone) {
        throw new DateTimeInputError('本地日期时间必须提供 IANA 时区，或在时间中包含 Z/UTC offset。')
    }
    return Temporal.PlainDateTime.from(dateTime, { overflow: 'reject' })
        .toZonedDateTime(localTimeZone, { disambiguation: 'reject' })
}

function normalizeTimeZone(value: string): string {
    const timeZone = requiredText(value, '时区不能为空。')
    if (timeZone.length > 64) throw new DateTimeInputError('时区长度不能超过 64 个字符。')
    if (timeZone !== 'UTC' && !/^[A-Za-z][A-Za-z0-9._+-]*\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(timeZone)) {
        throw new DateTimeInputError('时区必须使用 IANA 名称，例如 Asia/Shanghai；不接受 CST 等缩写。')
    }
    try {
        return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone).timeZoneId
    } catch {
        throw new DateTimeInputError(`无效的 IANA 时区：${timeZone}。`)
    }
}

function parseTimeOfDay(value: string): Temporal.PlainTime {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value)) {
        throw new DateTimeInputError('targetTime 必须使用 HH:mm 或 HH:mm:ss，例如 17:30。')
    }
    return Temporal.PlainTime.from(value, { overflow: 'reject' })
}

function differenceResult(
    operation: 'difference' | 'difference_from_now',
    start: Temporal.ZonedDateTime,
    end: Temporal.ZonedDateTime,
    extra: Record<string, unknown> = {}
): Record<string, unknown> {
    const differenceMilliseconds = end.epochMilliseconds - start.epochMilliseconds
    const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
    if (differenceMilliseconds > maxSafeInteger || differenceMilliseconds < -maxSafeInteger) {
        throw new DateTimeInputError('两个时间点的差值超出安全整数范围。')
    }
    const milliseconds = Number(differenceMilliseconds)
    return {
        operation,
        ...extra,
        start: snapshot(start),
        end: snapshot(end),
        relation: milliseconds > 0
            ? 'end_after_start'
            : milliseconds < 0
                ? 'end_before_start'
                : 'same_instant',
        totalMilliseconds: milliseconds,
        totalSeconds: milliseconds / 1000,
        totalMinutes: milliseconds / 60_000,
        absolute: elapsedBreakdown(Math.abs(milliseconds)),
    }
}

function readDuration(input: DateTimeArguments): Record<DurationUnit, number> {
    const duration = Object.fromEntries(durationUnits.map(unit => [unit, input[unit] ?? 0])) as Record<DurationUnit, number>
    const nonZeroValues = durationUnits.map(unit => duration[unit]).filter(value => value !== 0)
    if (nonZeroValues.length === 0) throw new DateTimeInputError('add_duration 至少需要一个非零时长字段。')
    if (new Set(nonZeroValues.map(Math.sign)).size > 1) {
        throw new DateTimeInputError('时长字段不能同时包含正数和负数。')
    }
    for (const unit of durationUnits) {
        const value = duration[unit]
        if (!Number.isSafeInteger(value)) throw new DateTimeInputError(`${unit} 必须是安全整数。`)
        if (Math.abs(value) > durationLimits[unit]) {
            throw new DateTimeInputError(`${unit} 绝对值不能超过 ${durationLimits[unit]}。`)
        }
    }
    return duration
}

function snapshot(value: Temporal.ZonedDateTime): Record<string, unknown> {
    return {
        iso: value.toString({ smallestUnit: 'millisecond' }),
        instant: value.toInstant().toString({ smallestUnit: 'millisecond' }),
        epochMilliseconds: Number(value.epochMilliseconds),
        timeZone: value.timeZoneId,
        offset: value.offset,
        year: value.year,
        month: value.month,
        day: value.day,
        hour: value.hour,
        minute: value.minute,
        second: value.second,
        dayOfWeek: value.dayOfWeek,
        dayOfWeekName: dayOfWeekNames[value.dayOfWeek - 1],
        dayOfYear: value.dayOfYear,
        weekOfYear: value.weekOfYear,
        yearOfWeek: value.yearOfWeek,
        daysInMonth: value.daysInMonth,
        daysInYear: value.daysInYear,
        monthsInYear: value.monthsInYear,
        hoursInDay: value.hoursInDay,
        inLeapYear: value.inLeapYear,
    }
}

function elapsedBreakdown(milliseconds: number): Record<string, number> {
    let remaining = milliseconds
    const days = Math.floor(remaining / 86_400_000)
    remaining -= days * 86_400_000
    const hours = Math.floor(remaining / 3_600_000)
    remaining -= hours * 3_600_000
    const minutes = Math.floor(remaining / 60_000)
    remaining -= minutes * 60_000
    const seconds = Math.floor(remaining / 1000)
    remaining -= seconds * 1000
    return { days, hours, minutes, seconds, milliseconds: remaining }
}

function requiredText(value: string | undefined, message: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new DateTimeInputError(message)
    return value.trim()
}

function toolInputError(message: string): AgentToolExecutionResult {
    return { content: message, isError: true }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason
}

class DateTimeInputError extends Error {}
