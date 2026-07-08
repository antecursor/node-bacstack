package com.antecursor.bacnet.sc.fixture;

import dev.bscs.bacnet.bacnetsc.SCDatalink;
import dev.bscs.bacnet.bacnetsc.SCProperties;
import dev.bscs.bacnet.bacnetsc.SCVMAC;
import dev.bscs.bacnet.stack.APDU;
import dev.bscs.bacnet.stack.ASNBuffer;
import dev.bscs.bacnet.stack.ApplicationLayer;
import dev.bscs.bacnet.stack.AuthData;
import dev.bscs.bacnet.stack.BACnetLog;
import dev.bscs.bacnet.stack.Device;
import dev.bscs.bacnet.stack.Failure;
import dev.bscs.bacnet.stack.NetworkLayer;
import dev.bscs.bacnet.stack.constants.AbortReason;
import dev.bscs.bacnet.stack.constants.ConfirmedServiceChoice;
import dev.bscs.bacnet.stack.constants.ErrorClass;
import dev.bscs.bacnet.stack.constants.ErrorCode;
import dev.bscs.bacnet.stack.constants.RejectReason;
import dev.bscs.bacnet.stack.data.BACnetObjectType;
import dev.bscs.bacnet.stack.data.BACnetPropertyIdentifier;
import dev.bscs.bacnet.stack.data.BACnetReliability;
import dev.bscs.bacnet.stack.data.BACnetStatusFlags;
import dev.bscs.bacnet.stack.data.base.BACnetARRAY;
import dev.bscs.bacnet.stack.data.base.BACnetBitString;
import dev.bscs.bacnet.stack.data.base.BACnetBoolean;
import dev.bscs.bacnet.stack.data.base.BACnetCharacterString;
import dev.bscs.bacnet.stack.data.base.BACnetData;
import dev.bscs.bacnet.stack.data.base.BACnetDataType;
import dev.bscs.bacnet.stack.data.base.BACnetEnumerated;
import dev.bscs.bacnet.stack.data.base.BACnetObjectIdentifier;
import dev.bscs.bacnet.stack.data.base.BACnetReal;
import dev.bscs.bacnet.stack.data.base.BACnetUnsigned;
import dev.bscs.bacnet.stack.objects.BACnetObject;
import dev.bscs.bacnet.stack.objects.DeviceObjectProperties;
import dev.bscs.common.Application;
import dev.bscs.common.Configuration;
import dev.bscs.common.Formatting;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public class JavaFixture extends Application {

    private SCDatalink hubDatalink;
    private SCDatalink fixtureDatalink;
    private FixtureDevice fixtureDevice;

    @Override protected void startShell() {
    }

    @Override protected void start() {
        int scNetworkNumber = configuration.getInteger("app.scNetworkNumber", 55502);

        Device hubDevice = new Device(configuration);
        SCProperties hubProperties = new SCProperties(configuration);
        hubProperties.hubFunctionEnable = true;
        hubProperties.directConnectEnable = false;
        hubProperties.nodeEnable = false;
        hubDatalink = new SCDatalink("SC-Hub", hubProperties, hubDevice, scNetworkNumber);

        fixtureDevice = new FixtureDevice(configuration);
        SCProperties fixtureProperties = new SCProperties(configuration);
        fixtureProperties.hubFunctionEnable = false;
        fixtureProperties.hubFunctionBindURI = "";
        fixtureProperties.directConnectEnable = false;
        fixtureProperties.directConnectBindURI = "";
        fixtureProperties.directConnectAcceptURIs = "";
        fixtureProperties.nodeEnable = true;
        fixtureProperties.primaryHubURI = configuration.getString("app.fixture.sc.primaryHubURI", "wss://127.0.0.1:4443");
        fixtureProperties.failoverHubURI = "";
        fixtureProperties.vmac = new SCVMAC(configuration.getMAC("app.fixture.sc.vmac", 6, fixtureProperties.vmac.toBytes()));
        fixtureDatalink = new SCDatalink("SC-Fixture", fixtureProperties, fixtureDevice, 0);

        hubDatalink.start();
        fixtureDatalink.start();
    }

    @Override protected void stop() {
        if (fixtureDatalink != null) fixtureDatalink.stop();
        if (hubDatalink != null) hubDatalink.stop();
    }

    @Override protected void close() {
        if (fixtureDatalink != null) fixtureDatalink.close();
        if (hubDatalink != null) hubDatalink.close();
    }

    public static class FixtureDevice extends Device {
        private final FixtureAnalogValueObject analogValueObject;
        private final FixtureTrendLogObject trendLogObject;

        public FixtureDevice(Configuration configuration) {
            super(configuration, makeDeviceObjectProperties(configuration));
            applicationLayer = new FixtureApplicationLayer(this);
            networkLayer = new NetworkLayer(this);

            analogValueObject = new FixtureAnalogValueObject(
                    configuration.getInteger("app.fixture.analog.instance", 1),
                    getFloat(configuration, "app.fixture.analog.initialValue", 12.5f),
                    configuration.getString("app.fixture.analog.name", "JavaFixture Analog Value")
            );
            trendLogObject = new FixtureTrendLogObject(
                    configuration.getInteger("app.fixture.trend.instance", 1),
                    configuration.getString("app.fixture.trend.name", "JavaFixture Trend Log"),
                    parseTrendValues(configuration.getString("app.fixture.trend.values", "1.25,2.5,3.75"))
            );

            addObject(analogValueObject);
            addObject(trendLogObject);
        }

        private static DeviceObjectProperties makeDeviceObjectProperties(Configuration configuration) {
            DeviceObjectProperties properties = new DeviceObjectProperties(configuration);
            properties.instance = configuration.getInteger("app.fixture.device.instance", 777001);
            properties.description = configuration.getString("app.fixture.device.description", "node-bacstack Java fixture");
            properties.modelName = configuration.getString("app.fixture.device.modelName", "node-bacstack Java Fixture");
            properties.namePrefix = configuration.getString("app.fixture.device.namePrefix", "JavaFixture-");
            properties.uuid = configuration.getUUID("app.fixture.device.uuid", UUID.fromString("77777777-0000-4000-8000-000000777001"));
            return properties;
        }

        private static float[] parseTrendValues(String raw) {
            String[] parts = raw.split(",");
            float[] values = new float[parts.length];
            for (int i = 0; i < parts.length; i++) values[i] = Float.parseFloat(parts[i].trim());
            return values;
        }

        private static float getFloat(Configuration configuration, String name, float defaultValue) {
            String value = configuration.getString(name, null);
            return value == null ? defaultValue : Float.parseFloat(value);
        }

        private void addObject(BACnetObject object) {
            objects.add(object);
            deviceObject.properties.objectList.value.add(new BACnetObjectIdentifier(object.objectIdentifier));
        }

        @Override public BACnetObject findObject(int objectIdentifier) {
            if (objectIdentifier == deviceObject.objectIdentifier ||
                    objectIdentifier == BACnetObjectIdentifier.combine(BACnetObjectType.DEVICE, 0x3FFFFF)) {
                return deviceObject;
            }
            for (BACnetObject object : objects) {
                if (object.objectIdentifier == objectIdentifier) return object;
            }
            return null;
        }

        @Override public BACnetObject findObject(String objectName) {
            for (BACnetObject object : objects) {
                if (object.objectName.equals(objectName)) return object;
            }
            return null;
        }
    }

    public static class FixtureApplicationLayer extends ApplicationLayer {
        public FixtureApplicationLayer(Device device) {
            super(device);
        }

        @Override public void nUnitdataIndication(int snet, byte[] sadr, boolean broadcast, byte[] data, int priority, boolean der, AuthData auth) {
            APDU apdu = new APDU(data);
            if (apdu.failure == null && apdu.pduType == APDU.CONF_REQ && !broadcast) {
                if (apdu.serviceRequest != null) apdu.serviceRequest.mark();
                switch (apdu.serviceChoice) {
                    case ConfirmedServiceChoice.WP:
                        FixtureWritePropertyService.indication(device, snet, sadr, apdu, auth);
                        return;
                    case ConfirmedServiceChoice.RR:
                        FixtureReadRangeService.indication(device, snet, sadr, apdu, auth);
                        return;
                    default:
                        break;
                }
            }
            super.nUnitdataIndication(snet, sadr, broadcast, data, priority, der, auth);
        }
    }

    public static class FixtureAnalogValueObject extends BACnetObject {
        private float presentValue;
        private final BACnetARRAY propertyList;

        public FixtureAnalogValueObject(int instance, float initialValue, String name) {
            objectType = BACnetObjectType.ANALOG_VALUE;
            objectIdentifier = BACnetObjectIdentifier.combine(objectType, instance);
            objectName = name;
            presentValue = initialValue;
            propertyList = new BACnetARRAY(
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_TYPE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_IDENTIFIER),
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_NAME),
                    new BACnetEnumerated(BACnetPropertyIdentifier.PRESENT_VALUE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.STATUS_FLAGS),
                    new BACnetEnumerated(BACnetPropertyIdentifier.EVENT_STATE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.OUT_OF_SERVICE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.UNITS),
                    new BACnetEnumerated(BACnetPropertyIdentifier.RELIABILITY)
            );
        }

        @Override public BACnetData findProperty(int propertyIdentifier) {
            switch (propertyIdentifier) {
                case BACnetPropertyIdentifier.PRESENT_VALUE:
                    return new BACnetReal(presentValue);
                case BACnetPropertyIdentifier.STATUS_FLAGS:
                    return new BACnetStatusFlags();
                case BACnetPropertyIdentifier.EVENT_STATE:
                    return new BACnetEnumerated(0);
                case BACnetPropertyIdentifier.OUT_OF_SERVICE:
                    return new BACnetBoolean(false);
                case BACnetPropertyIdentifier.UNITS:
                    return new BACnetEnumerated(95);
                case BACnetPropertyIdentifier.RELIABILITY:
                    return new BACnetEnumerated(BACnetReliability.NO_FAULT_DETECTED);
                case BACnetPropertyIdentifier.PROPERTY_LIST:
                    return propertyList;
                default:
                    return super.findProperty(propertyIdentifier);
            }
        }

        @Override public void setProperty(int propertyIdentifier, BACnetData data) throws Failure.Error {
            if (propertyIdentifier != BACnetPropertyIdentifier.PRESENT_VALUE) {
                super.setProperty(propertyIdentifier, data);
                return;
            }
            if (data.getDataType() != BACnetDataType.REAL) {
                throw new Failure.Error(ErrorClass.PROPERTY, ErrorCode.INVALID_DATA_TYPE);
            }
            presentValue = data.asReal().value;
        }

        @Override public int[] getAllPropertyIdentifiers() {
            return new int[]{
                    BACnetPropertyIdentifier.OBJECT_TYPE,
                    BACnetPropertyIdentifier.OBJECT_IDENTIFIER,
                    BACnetPropertyIdentifier.OBJECT_NAME,
                    BACnetPropertyIdentifier.PRESENT_VALUE,
                    BACnetPropertyIdentifier.STATUS_FLAGS,
                    BACnetPropertyIdentifier.EVENT_STATE,
                    BACnetPropertyIdentifier.OUT_OF_SERVICE,
                    BACnetPropertyIdentifier.UNITS,
                    BACnetPropertyIdentifier.RELIABILITY
            };
        }

        @Override public int[] getRequiredPropertyIdentifiers() {
            return getAllPropertyIdentifiers();
        }

        @Override public int[] getOptionalPropertyIdentifiers() {
            return new int[]{BACnetPropertyIdentifier.RELIABILITY};
        }
    }

    public static class FixtureTrendLogObject extends BACnetObject {
        private final float[] values;
        private final BACnetARRAY propertyList;

        public FixtureTrendLogObject(int instance, String name, float[] values) {
            objectType = BACnetObjectType.TRENDLOG;
            objectIdentifier = BACnetObjectIdentifier.combine(objectType, instance);
            objectName = name;
            this.values = values;
            propertyList = new BACnetARRAY(
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_TYPE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_IDENTIFIER),
                    new BACnetEnumerated(BACnetPropertyIdentifier.OBJECT_NAME),
                    new BACnetEnumerated(BACnetPropertyIdentifier.LOG_BUFFER),
                    new BACnetEnumerated(BACnetPropertyIdentifier.RECORD_COUNT),
                    new BACnetEnumerated(BACnetPropertyIdentifier.TOTAL_RECORD_COUNT),
                    new BACnetEnumerated(BACnetPropertyIdentifier.BUFFER_SIZE),
                    new BACnetEnumerated(BACnetPropertyIdentifier.STATUS_FLAGS)
            );
        }

        @Override public BACnetData findProperty(int propertyIdentifier) {
            switch (propertyIdentifier) {
                case BACnetPropertyIdentifier.RECORD_COUNT:
                case BACnetPropertyIdentifier.TOTAL_RECORD_COUNT:
                case BACnetPropertyIdentifier.BUFFER_SIZE:
                    return new BACnetUnsigned(values.length);
                case BACnetPropertyIdentifier.STATUS_FLAGS:
                    return new BACnetStatusFlags();
                case BACnetPropertyIdentifier.PROPERTY_LIST:
                    return propertyList;
                default:
                    return super.findProperty(propertyIdentifier);
            }
        }

        public float[] readRangeByPosition(int position, int count) {
            if (position < 1) position = 1;
            if (count < 0) count = -count;
            if (count == 0) count = values.length;
            int start = Math.min(position - 1, values.length);
            int end = Math.min(start + count, values.length);
            float[] result = new float[end - start];
            System.arraycopy(values, start, result, 0, result.length);
            return result;
        }

        @Override public boolean canReadProperty(int propertyIdentifier, AuthData auth) {
            return true;
        }

        @Override public int[] getAllPropertyIdentifiers() {
            return new int[]{
                    BACnetPropertyIdentifier.OBJECT_TYPE,
                    BACnetPropertyIdentifier.OBJECT_IDENTIFIER,
                    BACnetPropertyIdentifier.OBJECT_NAME,
                    BACnetPropertyIdentifier.LOG_BUFFER,
                    BACnetPropertyIdentifier.RECORD_COUNT,
                    BACnetPropertyIdentifier.TOTAL_RECORD_COUNT,
                    BACnetPropertyIdentifier.BUFFER_SIZE,
                    BACnetPropertyIdentifier.STATUS_FLAGS
            };
        }

        @Override public int[] getRequiredPropertyIdentifiers() {
            return getAllPropertyIdentifiers();
        }

        @Override public int[] getOptionalPropertyIdentifiers() {
            return new int[]{BACnetPropertyIdentifier.LOG_BUFFER};
        }
    }

    public static class FixtureWritePropertyService {
        private static final BACnetLog log = new BACnetLog(FixtureWritePropertyService.class);

        public static void indication(Device device, int snet, byte[] sadr, APDU apdu, AuthData auth) {
            ASNBuffer request = apdu.serviceRequest;
            int invokeID = apdu.inv;
            try {
                int objectIdentifier = request.readObjectIdentitfier(0);
                int propertyIdentifier = request.readEnumerated(1);
                request.readUnsigned(2, -1);
                request.readOpenTag(3);
                BACnetData value = request.readPrimitive();
                request.readCloseTag(3);
                if (request.remaining() > 0 && request.peekContextTag(4)) request.readUnsigned(4);
                if (request.remaining() > 0) throw new Failure.Reject(RejectReason.TOO_MANY_ARGUMENTS);
                BACnetObject object = device.findObject(objectIdentifier);
                if (object == null) throw new Failure.Error(ErrorClass.OBJECT, ErrorCode.UNKNOWN_OBJECT);
                object.setProperty(propertyIdentifier, value);
                device.applicationLayer.sendAck(snet, sadr, ConfirmedServiceChoice.WP, invokeID);
            }
            catch (Failure.Reject e) {
                log.error(device, "WP", "Rejecting WP from " + Formatting.toNetMac(snet, sadr) + " inv" + invokeID + " reject=" + e);
                device.applicationLayer.sendReject(snet, sadr, invokeID, e.rejectReason);
            }
            catch (Failure.Error e) {
                log.error(device, "WP", "Sending Error for WP from " + Formatting.toNetMac(snet, sadr) + " inv" + invokeID + " error=" + e);
                device.applicationLayer.sendError(snet, sadr, ConfirmedServiceChoice.WP, invokeID, e.errorClass, e.errorCode);
            }
        }
    }

    public static class FixtureReadRangeService {
        private static final BACnetLog log = new BACnetLog(FixtureReadRangeService.class);

        public static void indication(Device device, int snet, byte[] sadr, APDU apdu, AuthData auth) {
            ASNBuffer request = apdu.serviceRequest;
            int invokeID = apdu.inv;
            try {
                int objectIdentifier = request.readObjectIdentitfier(0);
                int propertyIdentifier = request.readEnumerated(1);
                int arrayIndex = (int)request.readUnsigned(2, -1);
                request.readOpenTag(3);
                int position = (int)request.readUnsigned();
                int count = (int)request.readInteger();
                request.readCloseTag(3);
                if (request.remaining() > 0) throw new Failure.Reject(RejectReason.TOO_MANY_ARGUMENTS);
                BACnetObject object = device.findObject(objectIdentifier);
                if (object == null) throw new Failure.Error(ErrorClass.OBJECT, ErrorCode.UNKNOWN_OBJECT);
                if (!(object instanceof FixtureTrendLogObject) || propertyIdentifier != BACnetPropertyIdentifier.LOG_BUFFER) {
                    throw new Failure.Error(ErrorClass.PROPERTY, ErrorCode.UNKNOWN_PROPERTY);
                }
                float[] values = ((FixtureTrendLogObject)object).readRangeByPosition(position, count);
                ASNBuffer response = new ASNBuffer(1497);
                response.writeObjectIdentitfier(0, objectIdentifier);
                response.writeEnumerated(1, propertyIdentifier);
                if (arrayIndex != -1) response.writeUnsigned(2, arrayIndex);
                response.writeBitString(3, new byte[]{0, 0});
                response.writeUnsigned(4, values.length);
                response.writeOpenTag(5);
                for (float value : values) response.writeReal(value);
                response.writeCloseTag(5);
                response.flip();
                if (response.limit() > apdu.getMaxResponseSize()) {
                    device.applicationLayer.sendAbort(snet, sadr, invokeID, AbortReason.SEGMENTATION_NOT_SUPPORTED, true);
                }
                else {
                    APDU responseApdu = new APDU(APDU.CONF_ACK, ConfirmedServiceChoice.RR, invokeID, response);
                    device.applicationLayer.sendAPDU(snet, sadr, responseApdu);
                }
            }
            catch (Failure.Reject e) {
                log.error(device, "RR", "Rejecting RR from " + Formatting.toNetMac(snet, sadr) + " inv" + invokeID + " reject=" + e);
                device.applicationLayer.sendReject(snet, sadr, invokeID, e.rejectReason);
            }
            catch (Failure.Error e) {
                log.error(device, "RR", "Sending Error for RR from " + Formatting.toNetMac(snet, sadr) + " inv" + invokeID + " error=" + e);
                device.applicationLayer.sendError(snet, sadr, ConfirmedServiceChoice.RR, invokeID, e.errorClass, e.errorCode);
            }
            catch (Failure.Abort e) {
                log.error(device, "RR", "Aborting RR from " + Formatting.toNetMac(snet, sadr) + " inv" + invokeID + " abort=" + e);
                device.applicationLayer.sendAbort(snet, sadr, invokeID, e.abortReason, true);
            }
        }
    }
}
