/*
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

import { getSupportedInterfaces } from 'ask-sdk-core';
import { IntentRequest, interfaces } from 'ask-sdk-model';
import { expect } from 'chai';
import { suite, test } from 'mocha';
import sinon from 'sinon';
import {
    AmazonBuiltInSlotType,
    ControlHandler,
    ControlResponseBuilder,
    DateControl,
    InputUtil,
    IntentBuilder,
    ListControl,
    Logger,
    SimplifiedIntent,
    SkillInvoker,
    wrapRequestHandlerAsSkill,
} from '../src';
import { NumberControl } from '../src/commonControls/numberControl/NumberControl';
import { ValueControl } from '../src/commonControls/ValueControl';
import { Strings as $ } from '../src/constants/Strings';
import { ContainerControl } from '../src/controls/ContainerControl';
import { Control } from '../src/controls/Control';
import { ControlInput } from '../src/controls/ControlInput';
import { ControlManager } from '../src/controls/ControlManager';
import { ControlResultBuilder } from '../src/controls/ControlResult';
import { GeneralControlIntent } from '../src/intents/GeneralControlIntent';
import { unpackValueControlIntent, ValueControlIntent } from '../src/intents/ValueControlIntent';
import { SessionBehavior } from '../src/runtime/SessionBehavior';
import { ValueChangedAct, ValueSetAct } from '../src/systemActs/ContentActs';
import { RequestChangedValueAct, RequestValueAct } from '../src/systemActs/InitiativeActs';
import { SystemAct } from '../src/systemActs/SystemAct';
import {
    findControlInTreeById,
    simpleInvoke,
    TestInput,
    waitForDebugger,
} from '../src/utils/testSupport/TestingUtils';
import { GameStrings as $$ } from './game_strings';
import UserEvent = interfaces.alexa.presentation.apl.UserEvent;

waitForDebugger();

suite('== Single value selector scenarios ==', () => {
    class SingleSelectorManager extends ControlManager {
        createControlTree(): Control {
            const topControl = new ContainerControl({ id: 'root' });
            topControl.addChild(
                new ValueControl({
                    id: $$.ID.PlayerName,
                    slotType: 'CUSTOM.name',
                    prompts: { requestValue: 'none' },
                    interactionModel: { targets: [$$.Target.Name] },
                }),
            );

            return topControl;
        }
    }
    test('simple set-value input should be processed.', async () => {
        // Note: this test demonstrates calling handle() on a single control (yielding a ControlResult)

        const rootControl = new SingleSelectorManager().createControlTree();
        const input = TestInput.of(
            ValueControlIntent.of('CUSTOM.name', {
                action: $.Action.Set,
                target: $$.Target.Name,
                'CUSTOM.name': 'Mike',
            }),
        );
        const result = new ControlResultBuilder(undefined!);
        await rootControl.canHandle(input);
        await rootControl.handle(input, result);
        const playerNameState = findControlInTreeById(rootControl, $$.ID.PlayerName);
        expect(playerNameState.state.value).eq('Mike');
        expect(result.acts).length(1);
        expect(result.acts[0]).instanceOf(ValueSetAct);
    });

    test('valueType mismatch should cause processing to throw', async () => {
        const rootControl = new SingleSelectorManager().createControlTree();
        const input = TestInput.of(
            ValueControlIntent.of('AMAZON.Number', {
                action: $.Action.Set,
                target: $$.Target.Name,
                'AMAZON.Number': 'Mike',
            }),
        );
        expect(async () => {
            await rootControl.handle(input, new ControlResultBuilder(undefined!));
        }).throws;
    });

    test('session ending due to lack of initiative', async () => {
        const rootControl = new SingleSelectorManager().createControlTree();
        const input = TestInput.of(
            ValueControlIntent.of('CUSTOM.name', {
                action: $.Action.Set,
                target: $$.Target.Name,
                'CUSTOM.name': 'Mike',
            }),
        );
        const result = await simpleInvoke(rootControl, input);
        expect(result.acts[0]).instanceOf(ValueSetAct);
        expect(result.sessionBehavior).equals(SessionBehavior.OPEN);
    });
});

suite(
    '== Two controls that collect numbers. One is ValueControl{AMAZON.NUMBER} and other is NumberControl ==',
    () => {
        const PLAYER_COUNT = 'playerCount'; // used for both controlID and target.
        const PLAYER_AGE = 'playerAge'; // used for both controlID and target.

        class TwoSelectorManager extends ControlManager {
            createControlTree(state?: any, input?: ControlInput): Control {
                const rootControl = new ContainerControl({ id: 'root' });

                rootControl
                    .addChild(
                        new ValueControl({
                            id: PLAYER_COUNT,
                            slotType: 'AMAZON.NUMBER',
                            prompts: { requestValue: 'none' },
                            interactionModel: { targets: [PLAYER_COUNT] },
                        }),
                    )
                    .addChild(
                        new NumberControl({
                            id: PLAYER_AGE,
                            prompts: { requestValue: 'none' },
                            interactionModel: { targets: [PLAYER_AGE] },
                        }),
                    );

                return rootControl;
            }
        }

        test('U: set count, A: move focus and ask question', async () => {
            // Note: this test demonstrates calling simpleInvoke() which includes the initiative phase (yielding a composite ControlResult)

            const rootControl = new TwoSelectorManager().createControlTree();
            const input = TestInput.of(
                ValueControlIntent.of(AmazonBuiltInSlotType.NUMBER, {
                    action: $.Action.Set,
                    target: PLAYER_COUNT,
                    'AMAZON.NUMBER': '3',
                }),
            );
            const result = await simpleInvoke(rootControl, input);
            const playerCountState = findControlInTreeById(rootControl, PLAYER_COUNT);
            expect(playerCountState.state.value).eq('3');
            expect(result.acts[0]).instanceOf(ValueSetAct);
            expect(result.acts[1]).instanceOf(RequestValueAct);
        });

        test('U: set count, A:move focus and ask question, U: change count to specific value', async () => {
            const rootControl = new TwoSelectorManager().createControlTree();

            // -- turn 1
            const input1 = TestInput.of(
                ValueControlIntent.of(AmazonBuiltInSlotType.NUMBER, {
                    action: $.Action.Set,
                    target: PLAYER_COUNT,
                    'AMAZON.NUMBER': '3',
                }),
            );
            const result1 = await simpleInvoke(rootControl, input1);

            expect(result1.acts).length(2);
            expect((result1.acts[1] as SystemAct).control.id).eq(PLAYER_AGE); // <-- ask for age

            // -- turn 2
            const request2 = TestInput.of(
                ValueControlIntent.of(AmazonBuiltInSlotType.NUMBER, {
                    action: $.Action.Change,
                    target: PLAYER_COUNT,
                    'AMAZON.NUMBER': '4',
                }),
            );
            const result2 = await simpleInvoke(rootControl, request2);

            const playerCountState = findControlInTreeById(rootControl, PLAYER_COUNT);
            expect(playerCountState.state.value).eq('4'); // <--- changed successfully
            expect(result2.acts[0]).instanceOf(ValueChangedAct); // <--- appropriate feedback act
            expect(result2.acts[1]).instanceOf(RequestValueAct); // <-- ask for age again.
            expect((result2.acts[1] as SystemAct).control.id).eq(PLAYER_AGE); // <-- ask for age again.
        });

        test('U: set count, A:move focus and ask question, U: change count, A: request value, U: give value (multi-step set)', async () => {
            const rootControl = new TwoSelectorManager().createControlTree();

            // -- turn 1
            const input1 = TestInput.of(
                ValueControlIntent.of(AmazonBuiltInSlotType.NUMBER, {
                    action: $.Action.Set,
                    target: PLAYER_COUNT,
                    'AMAZON.NUMBER': '3',
                }),
            );
            const result1 = await simpleInvoke(rootControl, input1);
            expect(result1.acts).length(2);
            expect(result1.acts[1]).instanceof(RequestValueAct);

            // -- turn 2
            const input2 = TestInput.of(
                GeneralControlIntent.of({ action: $.Action.Change, target: PLAYER_COUNT }),
            );
            const result2 = await simpleInvoke(rootControl, input2);
            expect(result2.acts[0]).instanceOf(RequestChangedValueAct);
            expect((result2.acts[0] as SystemAct).control.id).eq(PLAYER_COUNT);

            // -- turn 3
            const input3 = TestInput.of(
                ValueControlIntent.of(AmazonBuiltInSlotType.NUMBER, { 'AMAZON.NUMBER': '4' }),
            );
            const result3 = await simpleInvoke(rootControl, input3);

            expect(result3.acts[0]).instanceOf(ValueChangedAct);
            expect((result3.acts[0] as SystemAct).control.id).eq(PLAYER_COUNT);
            expect(result3.acts[1]).instanceOf(RequestValueAct);
            expect((result3.acts[1] as SystemAct).control.id === PLAYER_AGE);
        });
    },
);

suite('== Custom Handler function scenarios ==', () => {
    class DateSelectorManager extends ControlManager {
        createControlTree(): Control {
            const topControl = new ContainerControl({ id: 'root' });

            // DateControl
            const dateControl = new DateControl({
                id: 'dateControl',
                interactionModel: {
                    targets: [$.Target.Date],
                    actions: {
                        set: [$.Action.Set],
                        change: [$.Action.Change],
                    },
                },
                inputHandling: {
                    customHandlingFuncs: [
                        {
                            name: 'SetDateEvent',
                            canHandle: isSetDateEvent,
                            handle: handleSetDateEvent,
                        },
                        {
                            name: 'SetValue',
                            canHandle: isSetValue,
                            handle: handleSetValue,
                        },
                    ],
                },
            });

            function isSetDateEvent(input: ControlInput) {
                return InputUtil.isIntent(input, 'SetDateEventIntent');
            }

            function handleSetDateEvent(input: ControlInput) {
                const intent = SimplifiedIntent.fromIntent((input.request as IntentRequest).intent);
                if (intent.slotResolutions.date !== undefined) {
                    const dateValue = intent.slotResolutions.date;
                    dateControl.setValue(dateValue.slotValue);
                }
            }

            function isSetValue(input: ControlInput) {
                return InputUtil.isValueControlIntent(input, AmazonBuiltInSlotType.DATE);
            }

            function handleSetValue(input: ControlInput) {
                const { values } = unpackValueControlIntent((input.request as IntentRequest).intent);
                const valueStr = values[0];
                dateControl.setValue(valueStr.slotValue);
            }

            topControl.addChild(dateControl);
            return topControl;
        }
    }

    test('Check custom handlers are invoked.', async () => {
        // Note: this test demonstrates calling customHandlingFuncs if defined on a control

        const rootControl = new DateSelectorManager().createControlTree();
        const input = TestInput.of(
            IntentBuilder.of('SetDateEventIntent', {
                date: '2020-01-01',
            }),
        );
        const result = new ControlResultBuilder(undefined!);
        await rootControl.canHandle(input);
        await rootControl.handle(input, result);
        const dateControlState = findControlInTreeById(rootControl, 'dateControl');
        expect(dateControlState.state.value).eq('2020-01-01');
    });

    test('Check conflicts in canHandle throws a error log', async () => {
        const rootControl = new DateSelectorManager().createControlTree();
        const input = TestInput.of(
            ValueControlIntent.of(AmazonBuiltInSlotType.DATE, {
                'AMAZON.DATE': '2018',
                action: $.Action.Set,
            }),
        );
        const spy = sinon.stub(Logger.prototype, 'error');
        const result = new ControlResultBuilder(undefined!);
        await rootControl.canHandle(input);
        await rootControl.handle(input, result);

        expect(
            spy.calledOnceWith(
                'More than one handler matched. Handlers in a single control should be mutually exclusive. Defaulting to the first. handlers: ["SetWithValue (built-in)","SetValue"]',
            ),
        ).eq(true);

        spy.restore();

        const dateControlState = findControlInTreeById(rootControl, 'dateControl');
        expect(dateControlState.state.value).eq('2018');
        expect(result.acts).length(1);
        expect(result.acts[0]).instanceOf(ValueSetAct);
    });
});

suite('== Custom List APL Props ==', () => {
    class ListSelector extends ControlManager {
        createControlTree(): Control {
            const topControl = new ContainerControl({ id: 'root' });

            // ListControl
            const houseControl = new ListControl({
                id: 'hogwarts',
                listItemIDs: getCategoriesList(),
                slotType: 'hogwartsHouse',
                validation: [
                    (state, input) =>
                        getCategoriesList().includes(state.value!)
                            ? true
                            : { renderedReason: 'houseControl validation Failed' },
                ],
                inputHandling: {
                    customHandlingFuncs: [
                        {
                            name: 'ButtonSelection (custom)',
                            canHandle: isButtonSelected,
                            handle: handleButtonSelection,
                        },
                        {
                            name: 'HouseSelection (custom)',
                            canHandle: isHouseSelected,
                            handle: handleHouseSelection,
                        },
                    ],
                },
                valueRenderer: (x: string, input) => ({
                    prompt: `Wizard House: ${x}`,
                    primaryText: `Wizard House: ${x}`,
                }),
            });

            function getCategoriesList(): string[] {
                return ['Gryffindor', 'Ravenclaw', 'Slytherin'];
            }

            function isButtonSelected(input: ControlInput): boolean {
                return InputUtil.isAPLUserEventWithMatchingSourceId(input, 'HouseTextButton');
            }

            async function handleButtonSelection(input: ControlInput, resultBuilder: ControlResultBuilder) {
                const houseId = (input.request as interfaces.alexa.presentation.apl.UserEvent).arguments![0];
                houseControl.setValue(houseId, true);
                await houseControl.validateAndAddActs(input, resultBuilder, $.Action.Set);
            }

            function isHouseSelected(input: ControlInput) {
                return InputUtil.isIntent(input, 'HouseSelectionIntent');
            }

            async function handleHouseSelection(input: ControlInput, resultBuilder: ControlResultBuilder) {
                if (getSupportedInterfaces(input.handlerInput.requestEnvelope)['Alexa.Presentation.APL']) {
                    const intent = SimplifiedIntent.fromIntent((input.request as IntentRequest).intent);
                    if (intent.slotResolutions.value !== undefined) {
                        const listSelectedValue = intent.slotResolutions.value;
                        houseControl.setValue(listSelectedValue.slotValue);
                        await houseControl.validateAndAddActs(input, resultBuilder, $.Action.Set);
                    }
                }
            }
            topControl.addChild(houseControl);
            return topControl;
        }
    }

    test('APL custom handlers are invoked.', async () => {
        // Note: this test demonstrates calling customHandlingFuncs if defined on a control

        const rootControl = new ListSelector().createControlTree();
        const input = TestInput.of(
            IntentBuilder.of('HouseSelectionIntent', {
                value: 'Hufflepuff',
            }),
        );
        const result = new ControlResultBuilder(undefined!);
        await rootControl.canHandle(input);
        await rootControl.handle(input, result);
        const houseControlState = findControlInTreeById(rootControl, 'hogwarts');
        expect(houseControlState.state.value).eq('Hufflepuff');
    });

    test('APL custom mapper for slotIds', async () => {
        const requestHandler = new ControlHandler(new ListSelector());
        const skill = new SkillInvoker(wrapRequestHandlerAsSkill(requestHandler));
        const testUserEvent: UserEvent = {
            type: 'Alexa.Presentation.APL.UserEvent',
            requestId: 'amzn1.echo-api.request.1',
            timestamp: '2019-10-04T18:48:22Z',
            locale: 'en-US',
            arguments: ['Muggle'],
            components: {},
            source: {
                type: 'TouchWrapper',
                handler: 'Press',
                id: 'HouseTextButton',
            },
            token: 'houseButtonToken',
        };
        const expectedDataSource = {
            general: { headerTitle: 'Please select', headerSubtitle: '', controlId: 'hogwarts' },
            choices: {
                listItems: [
                    { primaryText: 'Wizard House: Gryffindor' },
                    { primaryText: 'Wizard House: Ravenclaw' },
                    { primaryText: 'Wizard House: Slytherin' },
                ],
            },
        };
        const response = await skill.invoke(TestInput.userEvent(testUserEvent));
        const dataSource = (response as any).directive[0].datasources;

        expect(response.directive?.length).eq(1);
        expect(response.prompt).eq(
            'Sorry, Wizard House: Muggle is not a valid choice because houseControl validation Failed. What is your selection? Some suggestions are Wizard House: Gryffindor, Wizard House: Ravenclaw or Wizard House: Slytherin.',
        );
        expect(dataSource).deep.equals(expectedDataSource);
    });
});

class ExceptionHandlingControlManager1 extends ControlManager {
    createControlTree(): Control {
        throw new Error('synthetic error during createControlTree (ie. during canHandle)');
    }

    handleInternalError(
        controlInput: ControlInput | undefined,
        error: any,
        responseBuilder: ControlResponseBuilder,
    ) {
        controlInput?.handlerInput.responseBuilder.withShouldEndSession(true);
        responseBuilder.addPromptFragment('custom response prompt');
        responseBuilder.withShouldEndSession(true);
    }
}

class ExceptionHandlingControlManager2 extends ControlManager {
    createControlTree(): Control {
        return new ValueControl({
            id: 'a',
            slotType: 'dummy',
            inputHandling: {
                customHandlingFuncs: [
                    {
                        name: 'Exception generating handler',
                        canHandle: () => true,
                        handle: () => {
                            throw new Error('synthetic error during handle');
                        },
                    },
                ],
            },
        });
    }

    handleInternalError(
        controlInput: ControlInput | undefined,
        error: Error,
        responseBuilder: ControlResponseBuilder,
    ) {
        responseBuilder.addPromptFragment(`${error.message}`);
        responseBuilder.withShouldEndSession(true);
    }
}

suite('== Top-level exception handling ==', () => {
    test('Top-level exception during canHandle can produce response.', async () => {
        const spy = sinon.stub(Logger.prototype, 'error');
        const requestHandler = new ControlHandler(new ExceptionHandlingControlManager1());
        const skill = new SkillInvoker(wrapRequestHandlerAsSkill(requestHandler));
        const response = await skill.invoke(TestInput.launchRequest());
        expect(response.prompt).equals('custom response prompt');
        expect(response.responseEnvelope.response.shouldEndSession).equals(true);

        spy.restore();
    });

    test('Top-level exception during canHandle can return false.', async () => {
        const spy = sinon.stub(Logger.prototype, 'error');
        const controlHandler = new ControlHandler(new ExceptionHandlingControlManager1());
        controlHandler.canHandleThrowBehavior = 'ReturnFalse';
        const skill = new SkillInvoker(wrapRequestHandlerAsSkill(controlHandler));
        const response = await skill.invoke(TestInput.launchRequest());
        expect(response.prompt).equals('Unable to find a suitable request handler.');
        expect(response.responseEnvelope.response.shouldEndSession).equals(false);

        spy.restore();
    });

    test('Top-level exception during canHandle can throw.', async () => {
        const spy = sinon.stub(Logger.prototype, 'error');
        const controlHandler = new ControlHandler(new ExceptionHandlingControlManager1());
        controlHandler.canHandleThrowBehavior = 'Rethrow';
        const skill = new SkillInvoker(wrapRequestHandlerAsSkill(controlHandler));
        const response = await skill.invoke(TestInput.launchRequest());
        expect(response.prompt).equals('synthetic error during createControlTree (ie. during canHandle)');
        expect(response.responseEnvelope.response.shouldEndSession).equals(false);

        spy.restore();
    });

    test('Top-level exception during handle can end the session.', async () => {
        const spy = sinon.stub(Logger.prototype, 'error');
        const requestHandler = new ControlHandler(new ExceptionHandlingControlManager2());
        const skill = new SkillInvoker(wrapRequestHandlerAsSkill(requestHandler));
        const response = await skill.invoke(TestInput.launchRequest());
        expect(response.prompt).equals('synthetic error during handle');
        expect(response.responseEnvelope.response.shouldEndSession).equals(true);

        spy.restore();
    });
});
